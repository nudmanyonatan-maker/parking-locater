import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarSpot } from '../shared/types';
import { addAlertSub, buildDiscordPayload, reminderMessage, runReminderCheck, shouldFireReminder } from '../worker/car';
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
  it('fires from an hour before until 2 minutes after', () => {
    expect(shouldFireReminder({ ...base, moveBy: 61 * MIN }, 0)).toBe(false);
    expect(shouldFireReminder({ ...base, moveBy: 60 * MIN }, 0)).toBe(true);
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
  it('writes the phone alert with time, street, minutes left and note', () => {
    const moveBy = Date.parse('2026-10-09T15:30:00Z');
    const msg = reminderMessage({ ...base, moveBy, note: 'Hydrants', faceId: 'WEST 188 STREET|AMSTERDAM AVENUE|AUDUBON AVENUE|S' }, moveBy - 58 * MIN);
    expect(msg).toMatchObject({ title: 'Move your car 🚗', path: '/', ttl: 3600 });
    expect(msg.body).toBe('Street cleaning at 11:30 AM on W 188th St (in 58 min). 📝 Hydrants');
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
  it('sends the phone alert and drops phones that unsubscribed', async () => {
    const { env, kv } = envWith({ ...base, moveBy: now + 30 * MIN }, '');
    Object.assign(env, { VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y', VAPID_SUBJECT: 'https://example.test' });
    await addAlertSub(env, { endpoint: 'https://web.push.apple.com/gone', p256dh: 'a', auth: 'b' }, 'https://app.test');
    const push = await import('../worker/push');
    const send = vi.spyOn(push, 'sendPush').mockImplementation(async (_env, sub) =>
      sub.endpoint.endsWith('gone') ? { ok: false, status: 410, gone: true } : { ok: true, status: 201, gone: false },
    );
    expect(await runReminderCheck(env, now)).toBe('failed');
    expect(JSON.parse(kv.data.get('car-alerts')!).subs).toEqual([]);
    await addAlertSub(env, { endpoint: 'https://web.push.apple.com/phone', p256dh: 'a', auth: 'b' }, 'https://app.test');
    expect(await runReminderCheck(env, now)).toBe('sent');
    expect(send).toHaveBeenLastCalledWith(env, expect.objectContaining({ endpoint: 'https://web.push.apple.com/phone' }), expect.objectContaining({ tag: 'car-move' }), 'https://app.test');
    expect(JSON.parse(kv.data.get('spot')!).reminderSent).toBe(true);
    send.mockRestore();
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
  it('signs a phone up for alerts and off again (no token needed)', async () => {
    const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa', auth: 'tBHItJI5svbpez7KI4CCXg' } };
    expect((await h.call('/api/spot/alerts', { method: 'POST', json: sub })).status).toBe(200);
    expect((await h.call('/api/spot/alerts', { method: 'POST', json: { ...sub, endpoint: 'https://evil.example/x' } })).status).toBe(400);
    expect((await h.call('/api/spot/alerts', { method: 'DELETE', json: { endpoint: sub.endpoint } })).status).toBe(200);
  });
  it('keeps working with the old app body and rejects bad input', async () => {
    const old = await h.call('/api/spot', { method: 'PUT', json: { lat: 40.85, lng: -73.93, note: '', moveBy: null } });
    expect(((await old.json()) as CarSpot).moveBy).toBeNull();
    expect((await h.call('/api/spot', { method: 'PUT', json: { lat: 'x', lng: -73.93 } })).status).toBe(400);
    expect((await h.call('/api/spot', { method: 'PUT', body: '{oops', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  });
});
