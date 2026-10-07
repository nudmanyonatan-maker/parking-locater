// Web Push subscription management.
//   GET  /api/push/config       {enabled, publicKey}
//   POST /api/push/subscribe    admin: store a browser PushSubscription (upsert by endpoint)
//   POST /api/push/unsubscribe  public: forget an endpoint (knowing it is the capability)
//   POST /api/push/test         admin: send a test notification to every enabled subscription

import { Hono } from 'hono';
import type { PushConfigResponse } from '../../shared/types';
import { requireAdmin } from '../auth';
import { clearPushFailures, deleteSubscription, listEnabledSubscriptions, upsertSubscription } from '../db';
import { HttpError, readJson, type AppEnv } from '../http';
import { isAllowedPushEndpoint, pushConfigured } from '../push';
import { deliverPush } from '../services/alerts';
import { saveAppOrigin } from '../services/settings';
import { parseOrThrow, pushSubscriptionBody, pushUnsubscribeBody } from '../validation';

export const pushRoutes = new Hono<AppEnv>();

pushRoutes.get('/config', (c) => {
  const body: PushConfigResponse = { enabled: pushConfigured(c.env), publicKey: c.env.VAPID_PUBLIC_KEY ?? null };
  return c.json(body);
});

pushRoutes.post('/subscribe', requireAdmin, async (c) => {
  const body = parseOrThrow(pushSubscriptionBody, await readJson(c));
  if (!isAllowedPushEndpoint(body.endpoint)) {
    const message = 'Not a known push service endpoint';
    throw new HttpError(400, 'validation_failed', `endpoint: ${message}`, [{ path: 'endpoint', message }]);
  }
  await upsertSubscription(c.env.DB, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth }, new Date().toISOString());
  // Alerts sent from the cron have no request; remember where the app lives for notification links.
  await saveAppOrigin(c.env, new URL(c.req.url).origin);
  return c.json({ ok: true });
});

pushRoutes.post('/unsubscribe', async (c) => {
  const { endpoint } = parseOrThrow(pushUnsubscribeBody, await readJson(c));
  await deleteSubscription(c.env.DB, endpoint);
  return c.json({ ok: true });
});

pushRoutes.post('/test', requireAdmin, async (c) => {
  if (!pushConfigured(c.env)) throw new HttpError(503, 'push_not_configured', 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT to enable notifications.');
  const origin = new URL(c.req.url).origin;
  const message = { title: 'ParkNearMe', body: 'Test notification: alerts are working.', path: '/', tag: 'parknearme-test' };
  let sent = 0;
  let failed = 0;
  for (const sub of await listEnabledSubscriptions(c.env.DB)) {
    if (await deliverPush(c.env, sub, message, origin)) {
      await clearPushFailures(c.env.DB, sub.id);
      sent++;
    } else {
      failed++;
    }
  }
  return c.json({ sent, failed });
});
