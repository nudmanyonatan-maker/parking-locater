// "Where's my car" spot API (single user, no auth by design).
//   GET    /api/spot  CarSpot or null
//   PUT    /api/spot  {lat, lng, note?, moveBy?, faceId?} -> CarSpot (resets the reminder)
//   DELETE /api/spot  {ok: true}

import { Hono } from 'hono';
import type { CarSpot } from '../../shared/types';
import { deleteSpot, getSpot, putSpot } from '../car';
import { readJson, type AppEnv } from '../http';
import { parseOrThrow, spotBody } from '../validation';

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
