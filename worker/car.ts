// "Where's my car": the one current parking spot (KV key "spot") and the
// Discord "move your car" reminder, fired by the cron 5 minutes before moveBy.

import type { CarSpot } from '../shared/types';
import type { Env } from './env';

const SPOT_KEY = 'spot';
const FIVE_MIN_MS = 5 * 60_000;
const GRACE_MS = 2 * 60_000;

export async function getSpot(env: Env): Promise<CarSpot | null> {
  return (await env.PARKING_KV.get<CarSpot>(SPOT_KEY, 'json')) ?? null;
}

export async function putSpot(env: Env, spot: CarSpot): Promise<void> {
  await env.PARKING_KV.put(SPOT_KEY, JSON.stringify(spot));
}

export async function deleteSpot(env: Env): Promise<void> {
  await env.PARKING_KV.delete(SPOT_KEY);
}

/**
 * Should the cron fire the reminder now? Inside the window from 5 min before
 * moveBy until 2 min after, and only once (reminderSent).
 */
export function shouldFireReminder(spot: CarSpot | null, now: number): boolean {
  if (!spot || spot.moveBy == null || spot.reminderSent) return false;
  const delta = spot.moveBy - now;
  return delta <= FIVE_MIN_MS && delta > -GRACE_MS;
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
  return { content: `🚗 Move your car by ${when} (within 5 min).${noteLine}\n📍 ${mapLink}` };
}

/** POST to the Discord webhook; true on a 2xx. */
export async function sendDiscord(webhookUrl: string, payload: { content: string }): Promise<boolean> {
  const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.ok;
}

/** Cron: send the move-by reminder once. A failed POST retries next minute. */
export async function runReminderCheck(env: Env, now = Date.now()): Promise<'sent' | 'failed' | 'not_configured' | 'idle'> {
  const spot = await getSpot(env);
  if (!shouldFireReminder(spot, now)) return 'idle';
  if (!env.DISCORD_WEBHOOK_URL) {
    console.error('DISCORD_WEBHOOK_URL not configured');
    return 'not_configured';
  }
  if (await sendDiscord(env.DISCORD_WEBHOOK_URL, buildDiscordPayload(spot!))) {
    await putSpot(env, { ...spot!, reminderSent: true });
    return 'sent';
  }
  console.error('Discord webhook POST failed; will retry next run');
  return 'failed';
}
