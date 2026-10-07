// "Where's my car" helpers: home (kept on this device), distances, the
// Apple Maps walking link, and the move-by time from street cleaning.

import {
  faceLabel,
  faceWindows,
  findBlock,
  nextCleaning,
  windowNear,
  windowText,
  type CleaningData,
  type CleaningFace,
  type NextCleaning,
} from '../../shared/cleaning';
import type { CarSpot } from '../../shared/types';
import streetCleaningJson from '../data/street-cleaning.json';

export const streetCleaning = streetCleaningJson as unknown as CleaningData;

export interface LatLng {
  lat: number;
  lng: number;
}

/** 403 Audubon Ave (NYC GeoSearch); the 🏠 button on the map sets it exactly for this phone. */
export const DEFAULT_HOME: LatLng = { lat: 40.851304, lng: -73.930153 };
const HOME_KEY = 'home';

export function getHome(): LatLng {
  try {
    const h = JSON.parse(window.localStorage.getItem(HOME_KEY) ?? 'null') as Partial<LatLng> | null;
    if (h && Number.isFinite(h.lat) && Number.isFinite(h.lng)) return { lat: h.lat!, lng: h.lng! };
  } catch {
    // Storage blocked or bad JSON: use the default.
  }
  return DEFAULT_HOME;
}

export function setHome(p: LatLng): void {
  try {
    window.localStorage.setItem(HOME_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: home stays the default.
  }
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** "350 ft", "0.4 mi". */
export function formatDistance(m: number): string {
  const ft = m * 3.28084;
  return ft < 1000 ? `${Math.round(ft)} ft` : `${(m / 1609.34).toFixed(1)} mi`;
}

export const walkUrl = (p: LatLng) => `https://maps.apple.com/?daddr=${p.lat},${p.lng}&dirflg=w`;

const toLatLon = (p: LatLng) => ({ lat: p.lat, lon: p.lng });

export interface SpotCleaning {
  face: CleaningFace;
  /** Other sides of the same block, to switch to if GPS picked the wrong one. */
  others: CleaningFace[];
  label: string;
  /** Schedule of the nearest sign, e.g. "Fri 11:30 AM–1 PM". */
  schedule: string | null;
  next: NextCleaning | null;
}

/** Street cleaning where the car is: the detected block face (or `faceId` if chosen), its schedule and next cleaning. */
export function cleaningAt(p: LatLng, nowMs: number, faceId?: string | null): SpotCleaning | null {
  const match = findBlock(streetCleaning, toLatLon(p));
  if (!match) return null;
  const all = [match.face, ...match.others];
  const face = all.find((f) => f.id === faceId) ?? match.face;
  const w = windowNear(face, toLatLon(p)) ?? faceWindows(face)[0] ?? null;
  return {
    face,
    others: all.filter((f) => f !== face),
    label: faceLabel(face),
    schedule: w ? windowText(w) : null,
    next: w ? nextCleaning([w], nowMs) : null,
  };
}

/** When to move the car for this block face: the start of the next cleaning, or null. */
export function moveByFor(p: LatLng, nowMs: number, faceId?: string | null): { moveBy: number | null; faceId: string | null } {
  const c = cleaningAt(p, nowMs, faceId);
  if (!c) return { moveBy: null, faceId: null };
  // Parked during a cleaning: the next one after it is what matters once you're legal again.
  const next = c.next?.active ? nextCleaning(c.next ? [c.next.window] : [], c.next.end + 1) : c.next;
  return { moveBy: next?.start ?? null, faceId: c.face.id };
}

const weekdayTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** "Today 11:30 AM", "Tomorrow 8 AM", "Fri 11:30 AM" (New York time). */
export function whenText(ms: number, nowMs: number): string {
  const day = nyDay.format(new Date(ms));
  if (day === nyDay.format(new Date(nowMs))) return `Today ${timeOnly.format(ms).replace(':00', '')}`;
  if (day === nyDay.format(new Date(nowMs + 86_400_000))) return `Tomorrow ${timeOnly.format(ms).replace(':00', '')}`;
  return weekdayTime.format(ms).replace(':00', '');
}

/** The move-by line and how urgent it is. */
export function moveByStatus(spot: Pick<CarSpot, 'moveBy'>, nowMs: number): { text: string; tone: 'ok' | 'soon' | 'late' } | null {
  if (spot.moveBy == null) return null;
  const left = spot.moveBy - nowMs;
  if (left < 0) return { text: `Move-by time passed (${whenText(spot.moveBy, nowMs)})`, tone: 'late' };
  return { text: `Move by ${whenText(spot.moveBy, nowMs)}`, tone: left <= 30 * 60_000 ? 'soon' : 'ok' };
}

export interface CleaningRow {
  face: CleaningFace;
  label: string;
  schedule: string;
  next: NextCleaning | null;
}

/** Block faces around home with their schedules, nearest first. */
export function cleaningNear(home: LatLng, nowMs: number, maxM = 130, limit = 6): CleaningRow[] {
  const rows: CleaningRow[] = [];
  const seen = new Set<string>();
  const nearby = streetCleaning.faces
    .map((face) => ({ face, d: distanceFromHome(face, home) }))
    .filter((f) => f.d <= maxM)
    .sort((a, b) => a.d - b.d);
  for (const { face } of nearby) {
    const windows = faceWindows(face);
    const schedule = windows.map(windowText).join(', ');
    // NYC's data splits some block faces into overlapping pieces; one row per street side and schedule.
    const key = `${face.street}|${face.side}|${schedule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ face, label: faceLabel(face), schedule, next: nextCleaning(windows, nowMs) });
    if (rows.length === limit) break;
  }
  return rows;
}

const distanceFromHome = (face: CleaningFace, home: LatLng) =>
  Math.min(...face.points.map(([lat, lon]) => haversineMeters(home, { lat, lng: lon })));

/** The nearby side you can stay on the longest (its next cleaning is furthest away). */
export function longestFree(rows: CleaningRow[]): CleaningRow | null {
  return rows.filter((r) => r.next && !r.next.active).sort((a, b) => b.next!.start - a.next!.start)[0] ?? null;
}
