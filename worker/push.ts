// Web Push delivery (VAPID + aes128gcm) using only WebCrypto, via
// @block65/webcrypto-web-push v2. Works for Chrome, Firefox and iOS 16.4+
// Home Screen web apps.
//
// Apple constraints handled here: TTL header required, body under 4 KB (we
// skip the library's 4096-byte padding), JWT refreshed at most hourly.

import { encryptNotification, vapidHeaders, type PushSubscription } from '@block65/webcrypto-web-push';
import type { Env } from './env';

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Path inside the app to open, e.g. "/?camera=abc". */
  path: string;
  tag?: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** Subscription no longer exists (404/410): delete or disable it. */
  gone: boolean;
  reason?: string;
}

/** Push services we are willing to POST to. A subscription endpoint is client-supplied. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

export function pushConfigured(env: Env): env is Env & { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string } {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

// Apple: "Don't refresh your JWT more frequently than once per hour." Cached per push-service origin, per isolate.
const authCache = new Map<string, { value: string; until: number }>();

async function authorization(sub: PushSubscription, env: Env & { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string }) {
  const origin = new URL(sub.endpoint).origin;
  const hit = authCache.get(origin);
  if (hit && hit.until > Date.now()) return hit.value;
  const { headers } = await vapidHeaders(sub, {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  });
  authCache.set(origin, { value: headers.authorization, until: Date.now() + 3_600_000 });
  return headers.authorization;
}

/**
 * Payload in the Declarative Web Push shape (shown natively on iOS 18.4+ without
 * waking the service worker); public/sw.js also understands it on other browsers.
 * Declarative push needs absolute URLs, so `origin` must be the app's origin.
 */
export function buildPayload(msg: PushMessage, origin: string | null) {
  const abs = (p: string) => (origin ? new URL(p, origin).href : p);
  return {
    web_push: 8030,
    notification: {
      title: msg.title,
      body: msg.body,
      navigate: abs(msg.path),
      tag: msg.tag,
      icon: abs('/icons/icon-192.png'),
      data: { path: msg.path },
    },
    mutable: false,
  };
}

export async function sendPush(env: Env, sub: StoredSubscription, msg: PushMessage, origin: string | null): Promise<PushResult> {
  if (!pushConfigured(env)) return { ok: false, status: 0, gone: false, reason: 'push_not_configured' };
  if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true, reason: 'endpoint_not_allowed' };

  const subscription: PushSubscription = { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(buildPayload(msg, origin)));
    const body = await encryptNotification(subscription, plaintext, { pad: false });
    const headers: Record<string, string> = {
      authorization: await authorization(subscription, env),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '600', // a parking spot is stale after ~10 min
      urgency: 'high',
    };
    if (msg.tag && /^[A-Za-z0-9_-]{1,32}$/.test(msg.tag)) headers.topic = msg.tag;
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
    if (res.ok) return { ok: true, status: res.status, gone: false };
    const text = await res.text().catch(() => '');
    let reason: string | undefined;
    try {
      reason = (JSON.parse(text) as { reason?: string }).reason;
    } catch {
      reason = text.slice(0, 120) || undefined;
    }
    if (res.status === 403) authCache.delete(new URL(sub.endpoint).origin);
    return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, reason };
  } catch (e) {
    return { ok: false, status: 0, gone: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
