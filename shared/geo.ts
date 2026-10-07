// Distance helpers and camera filtering.

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_MI = 3958.7613;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in miles. */
export function haversineMiles(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees (0 = north, 90 = east). */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function isValidLatLon(p: Partial<LatLon> | null | undefined): p is LatLon {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}

/** Items within `radiusMi` of `home`, nearest first, with `distanceMi` attached. */
export function withinRadius<T extends LatLon>(items: T[], home: LatLon, radiusMi: number): (T & { distanceMi: number })[] {
  return items
    .filter(isValidLatLon)
    .map((item) => ({ ...item, distanceMi: haversineMiles(home, item) }))
    .filter((item) => item.distanceMi <= radiusMi)
    .sort((a, b) => a.distanceMi - b.distanceMi);
}

export function formatMiles(mi: number): string {
  if (mi < 0.1) return `${Math.round(mi * 5280)} ft`;
  return `${mi.toFixed(mi < 1 ? 2 : 1).replace(/0$/, '')} mi`;
}
