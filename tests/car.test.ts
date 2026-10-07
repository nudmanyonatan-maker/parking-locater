import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarSpot } from '../shared/types';
import { buildDiscordPayload, runReminderCheck, shouldFireReminder } from '../worker/car';
import { isParkingTick } from '../worker/cron';
import type { Env } from '../worker/env';
import { createHarness, type Harness } from './helpers/harness';
import { memoryKv } from './helpers/kv';

const base: CarSpot = { lat: 40.85, lng: -73.93, note: '', moveBy: null, createdAt: 0, reminderSent: false };
const MIN = 60_000;

describe('shouldFireReminder', () => {
  it('stays quiet without a spot, a move-by time, or once sent', () => {
    expect(shouldFireReminder(null, 0)).toBe(false);
    expect(shouldFireReminder({ ...base, moveBy: null }, 0)).toBe(false);
    expect(shouldFireReminder({ ...base, moveBy: MIN, reminderSent: true }, 0)).toBe(false);
  });
  it('fires from 5 minutes before until 2 minutes after', () => {
    expect(shouldFireReminder({ ...base, moveBy: 6 * MIN }, 0)).toBe(false);
    expect(shouldFireReminder({ ...base, moveBy: 5 * MIN }, 0)).toBe(true);
    expect(shouldFireReminder({ ...base, moveBy: MIN }, 0)).toBe(true);
    expect(shouldFireReminder({ ...base, moveBy: -MIN }, 0)).toBe(true);
    expect(shouldFireReminder({ ...base, moveBy: -3 * MIN }, 0)).toBe(false);
  });
  it('builds the Discord message with time, note and walking link', () => {
    const msg = buildDiscordPayload({ ...base, moveBy: Date.parse('2026-10-09T15:30:00Z'), note: 'Audubon east side' }).content;
    expect(msg).toContain('Move your car by Fri 11:30 AM');
    expect(msg).toContain('Note: Audubon east side');
    expect(msg).toContain('https://maps.apple.com/?daddr=40.85,-73.93&dirflg=w');
  });
});

describe('runReminderCheck', () => {
  const now = Date.parse('2026-10-09T15:27:00Z');
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  const envWith = (spot: CarSpot, webhook: string | undefined = 'https://discord.com/api/webhooks/1/x') => {
    const kv = memoryKv();
    kv.data.set('spot', JSON.stringify(spot));
    return { env: { PARKING_KV: kv, DISCORD_WEBHOOK_URL: webhook } as unknown as Env, kv };
  };

  it('posts once and marks the reminder sent', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { env, kv } = envWith({ ...base, moveBy: now + 3 * MIN });
    expect(await runReminderCheck(env, now)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(kv.data.get('spot')!).reminderSent).toBe(true);
    expect(await runReminderCheck(env, now + MIN)).toBe('idle');
  });
  it('retries after a failed post and reports a missing webhook', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const { env, kv } = envWith({ ...base, moveBy: now + 3 * MIN });
    expect(await runReminderCheck(env, now)).toBe('failed');
    expect(JSON.parse(kv.data.get('spot')!).reminderSent).toBe(false);
    expect(await runReminderCheck(envWith({ ...base, moveBy: now }, '').env, now)).toBe('not_configured');
  });
  it('runs camera work only on even minutes', () => {
    expect(isParkingTick(Date.parse('2026-10-07T14:02:00Z'))).toBe(true);
    expect(isParkingTick(Date.parse('2026-10-07T14:03:00Z'))).toBe(false);
  });
});

describe('/api/spot', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('saves, reads and clears the spot (no token needed)', async () => {
    expect(await (await h.call('/api/spot')).json()).toBeNull();
    const moveBy = Date.parse('2026-10-09T15:30:00Z');
    const put = await h.call('/api/spot', { method: 'PUT', json: { lat: 40.8513, lng: -73.9301, note: ' east side ', moveBy, faceId: 'AUDUBON AVENUE|WEST 185 STREET|WEST 186 STREET|E' } });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as CarSpot;
    expect(saved).toMatchObject({ lat: 40.8513, lng: -73.9301, note: 'east side', moveBy, reminderSent: false, faceId: 'AUDUBON AVENUE|WEST 185 STREET|WEST 186 STREET|E' });
    expect(await (await h.call('/api/spot')).json()).toEqual(saved);
    expect((await h.call('/api/spot', { method: 'DELETE' })).status).toBe(200);
    expect(await (await h.call('/api/spot')).json()).toBeNull();
  });
  it('keeps working with the old app body and rejects bad input', async () => {
    const old = await h.call('/api/spot', { method: 'PUT', json: { lat: 40.85, lng: -73.93, note: '', moveBy: null } });
    expect(((await old.json()) as CarSpot).moveBy).toBeNull();
    expect((await h.call('/api/spot', { method: 'PUT', json: { lat: 'x', lng: -73.93 } })).status).toBe(400);
    expect((await h.call('/api/spot', { method: 'PUT', body: '{oops', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  });
});
