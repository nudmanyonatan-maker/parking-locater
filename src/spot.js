// KV-backed storage for the single current parking spot.
// One key, "spot", holds the spot JSON (absent when no car is parked).

const SPOT_KEY = "spot";

export async function getSpot(env) {
  return await env.PARKING_KV.get(SPOT_KEY, "json");
}

export async function putSpot(env, spot) {
  await env.PARKING_KV.put(SPOT_KEY, JSON.stringify(spot));
}

export async function deleteSpot(env) {
  await env.PARKING_KV.delete(SPOT_KEY);
}
