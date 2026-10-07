// Push alerts: which candidates qualify, per-subscription dedupe and rate
// limits, and subscription health. sendPush is mocked; delivery itself is
// worker/push.ts's job.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { Detection, ParkingCandidate } from '../shared/types';
import { insertDetection } from '../worker/db';
import { sendPush, type PushResult } from '../worker/push';
import { alertCandidates, alertKey, alertMessage, evaluateAlerts, pickForSubscription, recentSpots } from '../worker/services/alerts';
import { CAM, createHarness, HOME, type Harness } from './helpers/harness';

vi.mock('../worker/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worker/push')>()),
  sendPush: vi.fn(),
}));
const send = vi.mocked(sendPush);

const candidate = (over: Partial<ParkingCandidate> = {}): ParkingCandidate => ({
  cameraId: CAM.audubon,
  regionId: 'lane-181-south',
  streetLabel: 'W 181st St at Audubon Ave',
  spaces: 1,
  confidence: 0.87,
  status: 'likely_available',
  gapStart: 0.54,
  gapEnd: 0.65,
  polygon: [
    [0.2, 0.8],
    [0.3, 0.8],
    [0.3, 0.7],
    [0.2, 0.7],
  ],
  lat: 40.8489,
  lon: -73.9322,
  approximateLocation: false,
  reasons: [],
  ...over,
});

const detection = (candidates: ParkingCandidate[], over: Partial<Detection> = {}): Detection => ({
  id: 1,
  cameraId: CAM.audubon,
  timestamp: new Date().toISOString(),
  frameFetchedAt: new Date().toISOString(),
  frameHash: 'abc',
  freshness: 'live',
  detector: 'test',
  vehiclesDetected: 8,
  parkedVehicles: 6,
  candidateSpaces: candidates.reduce((s, c) => s + c.spaces, 0),
  confidence: candidates[0]?.confidence ?? 0.7,
  status: candidates.length ? 'likely_available' : 'none',
  reason: null,
  objects: [],
  candidates,
  notes: [],
  error: null,
  ...over,
});

const settings = { ...DEFAULT_SETTINGS, notificationsEnabled: true, home: { ...DEFAULT_SETTINGS.home, ...HOME } };

describe('alert rules', () => {
  it('builds a short message and a stable key', () => {
    const c = candidate();
    expect(alertMessage(c)).toEqual({
      title: 'Parking spotted',
      body: 'W 181st St at Audubon Ave · 1 possible spot · 87%',
      path: `/?camera=${CAM.audubon}`,
      tag: 'parking-1ccb8d7c43d4',
    });
    expect(alertKey(c)).toBe(`${CAM.audubon}:lane-181-south:5`);
    expect(alertKey(candidate({ gapStart: 0.52 }))).toBe(alertKey(c));
  });

  it('only alerts on current, confident, nearby candidates', () => {
    const good = candidate();
    const weak = candidate({ confidence: 0.4, gapStart: 0.1 });
    const far = candidate({ lat: 40.86, lon: -73.93, gapStart: 0.8 });
    expect(alertCandidates(detection([weak, good, far]), settings)).toEqual([good]);
    expect(alertCandidates(detection([good]), { ...settings, notificationsEnabled: false })).toEqual([]);
    expect(alertCandidates(detection([good], { freshness: 'stale' }), settings)).toEqual([]);
    const old = new Date(Date.now() - 600_000).toISOString();
    expect(alertCandidates(detection([good], { timestamp: old }), settings)).toEqual([]);
  });

  it('dedupes the same spot for 30 min and rate-limits to one push per 5 min', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const c = candidate();
    const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    expect(pickForSubscription({ last_notified_at: null, last_notified_key: null }, [c], now)).toBe(c);
    expect(pickForSubscription({ last_notified_at: ago(3), last_notified_key: 'other' }, [c], now)).toBeNull();
    expect(pickForSubscription({ last_notified_at: ago(10), last_notified_key: alertKey(c) }, [c], now)).toBeNull();
    expect(pickForSubscription({ last_notified_at: ago(31), last_notified_key: alertKey(c) }, [c], now)).toBe(c);
    const other = candidate({ gapStart: 0.1 });
    expect(pickForSubscription({ last_notified_at: ago(10), last_notified_key: alertKey(c) }, [c, other], now)).toBe(other);
  });

  it('remembers every spot alerted in the last 30 min, not only the last one', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    const a = candidate({ gapStart: 0.1 });
    const b = candidate({ gapStart: 0.6 });
    const history = (spots: [ParkingCandidate, number][]) => JSON.stringify(spots.map(([c, min]) => ({ key: alertKey(c), at: ago(min) })));
    // A was sent 12 min ago, B 6 min ago: A must not come back yet.
    const sub = { last_notified_at: ago(6), last_notified_key: alertKey(b), notified_spots_json: history([[a, 12], [b, 6]]) };
    expect(pickForSubscription(sub, [a, b], now)).toBeNull();
    expect(recentSpots(sub, now).map((s) => s.key)).toEqual([alertKey(a), alertKey(b)]);
    // After 30 min a spot may be alerted again; unreadable history falls back to the last alert.
    expect(pickForSubscription({ ...sub, notified_spots_json: history([[a, 31], [b, 6]]) }, [a, b], now)).toBe(a);
    expect(pickForSubscription({ ...sub, notified_spots_json: '{oops' }, [b, a], now)).toBe(a);
  });
});

describe('evaluateAlerts', () => {
  let h: Harness;
  const vapid = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:test@example.com' };
  const subs = () =>
    h.db.sqlite.prepare('SELECT endpoint, enabled, failure_count, last_notified_key FROM notification_subscriptions ORDER BY id').all() as {
      endpoint: string;
      enabled: number;
      failure_count: number;
      last_notified_key: string | null;
    }[];
  const store = async (c: ParkingCandidate[]) => insertDetection(h.env.DB, detection(c));

  beforeEach(async () => {
    h = createHarness(vapid);
    send.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await h.call('/api/settings', { method: 'PUT', admin: true, json: { notificationsEnabled: true } });
    const insert = h.db.sqlite.prepare('INSERT INTO notification_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)');
    insert.run('https://fcm.googleapis.com/fcm/send/a', 'k1', 'a1', new Date().toISOString());
    insert.run('https://web.push.apple.com/b', 'k2', 'a2', new Date().toISOString());
    h.db.sqlite.prepare("INSERT INTO application_settings (key, value_json, updated_at) VALUES ('app_origin', '\"https://park.example\"', ?)").run(new Date().toISOString());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends once per subscription and then holds back', async () => {
    send.mockResolvedValue({ ok: true, status: 201, gone: false } satisfies PushResult);
    const d = await store([candidate()]);
    expect(await evaluateAlerts(h.env, d)).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    const [, sub, message, origin] = send.mock.calls[0]!;
    expect(sub).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'k1', auth: 'a1' });
    expect(message.title).toBe('Parking spotted');
    expect(origin).toBe('https://park.example');
    expect(subs().map((s) => s.last_notified_key)).toEqual([alertKey(candidate()), alertKey(candidate())]);

    expect(await evaluateAlerts(h.env, await store([candidate({ gapStart: 0.1 })]))).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends one push per subscription when several detections are evaluated at once', async () => {
    send.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 201, gone: false };
    });
    const ds = await Promise.all(Array.from({ length: 10 }, () => store([candidate()])));
    const sent = await Promise.all(ds.map((d) => evaluateAlerts(h.env, d)));
    expect(sent.reduce((a, b) => a + b, 0)).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map(([, sub]) => sub.endpoint)).size).toBe(2);
  });

  it('does not alternate between two spots that stay open', async () => {
    send.mockResolvedValue({ ok: true, status: 201, gone: false });
    const a = candidate({ gapStart: 0.1 });
    const b = candidate({ gapStart: 0.6, confidence: 0.8 });
    const t0 = Date.parse('2026-10-07T12:00:00Z');
    const sends: string[] = [];
    // The cron cadence: both gaps in every detection, every 2 minutes, for 40 minutes.
    for (let min = 0; min <= 40; min += 2) {
      const now = new Date(t0 + min * 60_000);
      const d = await insertDetection(h.env.DB, detection([a, b], { timestamp: now.toISOString() }));
      const before = send.mock.calls.length;
      if ((await evaluateAlerts(h.env, d, now)) > 0) {
        const [, , message] = send.mock.calls[before]!;
        sends.push(`${min}:${message.body === alertMessage(a).body ? 'A' : 'B'}:${send.mock.calls.length - before}`);
      }
    }
    // Each spot once per 30 minutes (both subscriptions each time); never A, B, A, B every 6 minutes.
    expect(sends).toEqual(['0:A:2', '6:B:2', '30:A:2', '36:B:2']);
  });

  it('disables gone subscriptions and ones that keep failing', async () => {
    send.mockImplementation(async (_env, sub) => (sub.endpoint.includes('apple') ? { ok: false, status: 410, gone: true } : { ok: false, status: 500, gone: false }));
    for (let i = 0; i < 5; i++) await evaluateAlerts(h.env, await store([candidate()]));
    expect(subs()).toEqual([
      { endpoint: 'https://fcm.googleapis.com/fcm/send/a', enabled: 0, failure_count: 5, last_notified_key: null },
      { endpoint: 'https://web.push.apple.com/b', enabled: 0, failure_count: 0, last_notified_key: null },
    ]);
    expect(send).toHaveBeenCalledTimes(6); // apple once (then disabled), fcm five times
  });

  it('does nothing without VAPID keys or with notifications off', async () => {
    const d = await store([candidate()]);
    expect(await evaluateAlerts({ ...h.env, VAPID_PRIVATE_KEY: undefined }, d)).toBe(0);
    await h.call('/api/settings', { method: 'PUT', admin: true, json: { notificationsEnabled: false } });
    expect(await evaluateAlerts(h.env, d)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a test push through the API', async () => {
    send.mockResolvedValueOnce({ ok: true, status: 201, gone: false }).mockResolvedValueOnce({ ok: false, status: 404, gone: true });
    const res = await h.call('/api/push/test', { method: 'POST', admin: true });
    expect(await res.json()).toEqual({ sent: 1, failed: 1 });
    expect(send.mock.calls[0]![3]).toBe('http://localhost');
    expect(subs().map((s) => s.enabled)).toEqual([1, 0]);
  });
});
