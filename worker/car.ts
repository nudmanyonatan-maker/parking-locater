// "Where's my car": the one current parking spot (KV key "spot") and the
// "move your car" reminder, fired by the cron an hour before moveBy as a phone
// notification (KV key "car-alerts") and, if set up, a Discord message.

import { prettyStreet } from '../shared/cleaning';
import type { CarSpot } from '../shared/types';
import type { Env } from './env';
import { sendPush, type PushMessage, type StoredSubscription } from './push';

const SPOT_KEY = 'spot';
const ALERTS_KEY = 'car-alerts';
const REMIND_BEFORE_MS = 60 * 60_000;
const GRACE_MS = 2 * 60_000;
/** Phones signed up for the reminder; the oldest drop off past this. */
const MAX_ALERT_SUBS = 10;

interface CarAlerts {
  /** The app's origin, for the notification link (the cron has no request). */
  origin: string | null;
  subs: StoredSubscription[];
}

export async function getSpot(env: Env): Promise<CarSpot | null> {
  return (await env.PARKING_KV.get<CarSpot>(SPOT_KEY, 'json')) ?? null;
}

export async function putSpot(env: Env, spot: CarSpot): Promise<void> {
  await env.PARKING_KV.put(SPOT_KEY, JSON.stringify(spot));
}

export async function deleteSpot(env: Env): Promise<void> {
  await env.PARKING_KV.delete(SPOT_KEY);
}

async function getAlerts(env: Env): Promise<CarAlerts> {
  return (await env.PARKING_KV.get<CarAlerts>(ALERTS_KEY, 'json')) ?? { origin: null, subs: [] };
}

/** Sign a phone up for the reminder (replaces the same endpoint). */
export async function addAlertSub(env: Env, sub: StoredSubscription, origin: string): Promise<void> {
  const { subs } = await getAlerts(env);
  const kept = subs.filter((s) => s.endpoint !== sub.endpoint);
  await env.PARKING_KV.put(ALERTS_KEY, JSON.stringify({ origin, subs: [...kept, sub].slice(-MAX_ALERT_SUBS) }));
}

export async function removeAlertSub(env: Env, endpoint: string): Promise<void> {
  const alerts = await getAlerts(env);
  await env.PARKING_KV.put(ALERTS_KEY, JSON.stringify({ ...alerts, subs: alerts.subs.filter((s) => s.endpoint !== endpoint) }));
}

/**
 * Should the cron fire the reminder now? From an hour before moveBy until
 * 2 min after, and only once (reminderSent).
 */
export function shouldFireReminder(spot: CarSpot | null, now: number): boolean {
  if (!spot || spot.moveBy == null || spot.reminderSent) return false;
  const delta = spot.moveBy - now;
  return delta <= REMIND_BEFORE_MS && delta > -GRACE_MS;
}

const nyTime = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).replace(':00', '');

/** "Street cleaning at 11:30 AM on W 188th St (in 58 min)." */
export function reminderMessage(spot: CarSpot, now: number): PushMessage {
  const street = spot.faceId ? ` on ${prettyStreet(spot.faceId.split('|')[0]!)}` : '';
  const mins = Math.max(0, Math.round(((spot.moveBy ?? now) - now) / 60_000));
  const note = spot.note ? ` 📝 ${spot.note}` : '';
  return {
    title: 'Move your car 🚗',
    body: `Street cleaning at ${nyTime(spot.moveBy ?? now)}${street} (in ${mins} min).${note}`,
    path: '/',
    tag: 'car-move',
    ttl: 3600,
  };
}

export function buildDiscordPayload(spot: CarSpot): { content: string } {
  const when = new Date(spot.moveBy ?? 0).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const mapLink = `https://maps.apple.com/?daddr=${spot.lat},${spot.lng}&dirflg=w`;
  const noteLine = spot.note ? `\nNote: ${spot.note}` : '';
  return { content: `🚗 Move your car by ${when}.${noteLine}\n📍 ${mapLink}` };
}

/** POST to the Discord webhook; true on a 2xx. */
export async function sendDiscord(webhookUrl: string, payload: { content: string }): Promise<boolean> {
  const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.ok;
}

/** Cron: send the move-by reminder once, to every signed-up phone (and Discord). Retries next minute if nothing got through. */
export async function runReminderCheck(env: Env, now = Date.now()): Promise<'sent' | 'failed' | 'not_configured' | 'idle'> {
  const spot = await getSpot(env);
  if (!spot || !shouldFireReminder(spot, now)) return 'idle';
  const alerts = await getAlerts(env);
  if (!alerts.subs.length && !env.DISCORD_WEBHOOK_URL) return 'not_configured';
  let sent = false;
  const message = reminderMessage(spot, now);
  for (const sub of alerts.subs) {
    const res = await sendPush(env, sub, message, alerts.origin);
    if (res.ok) sent = true;
    else if (res.gone) await removeAlertSub(env, sub.endpoint);
    else console.error(`car reminder push failed: ${res.status} ${res.reason ?? ''}`);
  }
  if (env.DISCORD_WEBHOOK_URL) {
    if (await sendDiscord(env.DISCORD_WEBHOOK_URL, buildDiscordPayload(spot))) sent = true;
    else console.error('Discord webhook POST failed');
  }
  if (!sent) return 'failed';
  await putSpot(env, { ...spot, reminderSent: true });
  return 'sent';
}
