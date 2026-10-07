// One-off: copy the saved car spot from the old Where's My Car app to this
// one, with the move-by time recomputed from the block's street cleaning.
// Usage (bundled with esbuild): node copy-spot.mjs OLD_URL NEW_URL

import { moveByFor } from '../src/lib/car';
import type { CarSpot } from '../shared/types';

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error('usage: copy-spot OLD_URL NEW_URL');

const old = (await (await fetch(`${from}/api/spot`)).json()) as CarSpot | null;
console.log('old spot:', JSON.stringify(old));
if (!old || !Number.isFinite(old.lat)) {
  console.log('No saved spot in the old app; nothing to copy.');
} else {
  const auto = moveByFor({ lat: old.lat, lng: old.lng }, Date.now());
  const body = { lat: old.lat, lng: old.lng, note: old.note ?? '', moveBy: auto.moveBy ?? old.moveBy ?? null, faceId: auto.faceId };
  const res = await fetch(`${to}/api/spot`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  console.log('new app:', res.status, await res.text());
  if (!res.ok) process.exit(1);
  if (body.moveBy) console.log('move by:', new Date(body.moveBy).toLocaleString('en-US', { timeZone: 'America/New_York' }), 'block:', auto.faceId);
}
