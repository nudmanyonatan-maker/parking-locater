// "Where's my car" spot API (single user, no auth by design).
//   GET    /api/spot  CarSpot or null
//   PUT    /api/spot  {lat, lng, note?, moveBy?, faceId?} -> CarSpot (resets the reminder)
//   DELETE /api/spot  {ok: true}
//   POST   /api/spot/alerts  PushSubscription: phone notification an hour before moveBy
//   DELETE /api/spot/alerts  {endpoint}

import { Hono } from 'hono';
import type { CarSpot } from '../../shared/types';
import { addAlertSub, deleteSpot, getSpot, putSpot, removeAlertSub } from '../car';
import { HttpError, readJson, type AppEnv } from '../http';
import { isAllowedPushEndpoint } from '../push';
import { parseOrThrow, pushSubscriptionBody, pushUnsubscribeBody, spotBody } from '../validation';

export const spotRoutes = new Hono<AppEnv>();

spotRoutes.get('/', async (c) => c.json(await getSpot(c.env)));

spotRoutes.put('/', async (c) => {
  const body = parseOrThrow(spotBody, await readJson(c));
  const spot: CarSpot = {
    lat: body.lat,
    lng: body.lng,
    note: (body.note ?? '').trim(),
    moveBy: body.moveBy ?? null,
    createdAt: Date.now(),
    reminderSent: false,
    faceId: body.faceId ?? null,
  };
  await putSpot(c.env, spot);
  return c.json(spot);
});

spotRoutes.delete('/', async (c) => {
  await deleteSpot(c.env);
  return c.json({ ok: true });
});

spotRoutes.post('/alerts', async (c) => {
  const body = parseOrThrow(pushSubscriptionBody, await readJson(c));
  if (!isAllowedPushEndpoint(body.endpoint)) {
    const message = 'Not a known push service endpoint';
    throw new HttpError(400, 'validation_failed', `endpoint: ${message}`, [{ path: 'endpoint', message }]);
  }
  await addAlertSub(c.env, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth }, new URL(c.req.url).origin);
  return c.json({ ok: true });
});

spotRoutes.delete('/alerts', async (c) => {
  const { endpoint } = parseOrThrow(pushUnsubscribeBody, await readJson(c));
  await removeAlertSub(c.env, endpoint);
  return c.json({ ok: true });
});
