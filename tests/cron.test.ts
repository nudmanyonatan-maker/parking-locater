// Cron handler: when background analysis runs, and daily retention.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduled } from '../worker/cron';
import { ageDetections, CAM, createHarness, watchAndCalibrate, type Harness } from './helpers/harness';

let h: Harness;

const controller = (iso: string): ScheduledController => ({ scheduledTime: Date.parse(iso), cron: '* * * * *', noRetry: () => {} });
/** The current minute, rounded down to an even one (camera work runs on even minutes only). */
const evenMinuteNow = () => {
  const d = new Date();
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 2));
  return d.toISOString();
};
const tick = (iso = evenMinuteNow()) => scheduled(controller(iso), h.env, { ...h.ctx });
const detectionCount = () => (h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM detections').get() as { n: number }).n;
const putSettings = (json: Record<string, unknown>) => h.call('/api/settings', { method: 'PUT', admin: true, json });

beforeEach(async () => {
  h = createHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await h.call('/api/cameras/sync', { method: 'POST', admin: true });
  await watchAndCalibrate(h);
});

afterEach(() => {
  expect(h.unexpected).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cron', () => {
  it('stays idle while nobody is using the app', async () => {
    await tick();
    expect(detectionCount()).toBe(0);
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('analyzes watched, calibrated cameras while the app is open', async () => {
    await h.call('/api/parking/current'); // records app_last_seen_at
    await tick();
    const rows = h.db.sqlite.prepare('SELECT camera_id, status FROM detections').all();
    expect(rows).toEqual([{ camera_id: CAM.audubon, status: 'possible' }]);
    expect(h.ai.run).toHaveBeenCalledTimes(1);

    // Inside the cooldown the next tick reuses the stored result.
    await tick();
    expect(detectionCount()).toBe(1);
  });

  it('respects backgroundMode', async () => {
    await putSettings({ backgroundMode: 'always' });
    await tick();
    expect(detectionCount()).toBe(1);

    ageDetections(h, CAM.audubon, 120);
    await h.call('/api/parking/current');
    await putSettings({ backgroundMode: 'off' });
    await tick();
    expect(detectionCount()).toBe(1);
  });

  it('runs while alerts are deliverable', async () => {
    await putSettings({ notificationsEnabled: true });
    await tick();
    expect(detectionCount()).toBe(0); // no subscription yet

    h.db.sqlite
      .prepare("INSERT INTO notification_subscriptions (endpoint, p256dh, auth, created_at) VALUES ('https://fcm.googleapis.com/fcm/send/x', 'k', 'a', ?)")
      .run(new Date().toISOString());
    await tick();
    expect(detectionCount()).toBe(1);
  });

  it('prunes detections older than 7 days at 08:00 UTC only', async () => {
    await putSettings({ backgroundMode: 'always' });
    await tick();
    ageDetections(h, CAM.audubon, 8 * 86_400);
    await h.settle();
    expect(detectionCount()).toBe(1);
    const candidates = () => (h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM parking_candidates').get() as { n: number }).n;
    expect(candidates()).toBeGreaterThan(0);

    await putSettings({ backgroundMode: 'off' });
    await tick('2026-10-07T09:00:00.000Z');
    expect(detectionCount()).toBe(1);
    await tick(new Date(new Date().setUTCHours(8, 0, 0, 0)).toISOString());
    expect(detectionCount()).toBe(0);
    expect(candidates()).toBe(0);
  });
});
