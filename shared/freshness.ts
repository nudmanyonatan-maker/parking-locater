// LIVE / STALE / OFFLINE rules for camera frames and detections.
//
// NYC TMC frames refresh every ~1-4 s and carry a burned-in clock. The API
// sends `cache-control: no-store` and no timestamp header, so we judge
// freshness from our own fetch times, whether the JPEG bytes change, and (for
// AXIS cameras that include it) the EXIF capture time.

import type { Freshness } from './types';

export const FRESHNESS = {
  /** Frame bytes unchanged for longer than this => STALE (camera frozen). */
  frozenAfterSeconds: 120,
  /** No successful fetch for longer than this => we no longer know. */
  unknownAfterSeconds: 15 * 60,
  /** EXIF capture time older than this (vs. our fetch time) => STALE. Lenient: camera clocks drift. */
  exifStaleAfterSeconds: 600,
  /** This many consecutive failed fetches => OFFLINE. */
  offlineAfterFailures: 2,
} as const;

export interface FrameObservation {
  catalogOnline: boolean;
  lastFetchedAt: string | null;
  lastChangedAt: string | null;
  consecutiveFailures: number;
  /** EXIF capture time of the last frame (UTC ISO), when the camera writes one. */
  lastCaptureAt?: string | null;
}

const ageSeconds = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 1000 : Infinity);

export function frameFreshness(o: FrameObservation, now = new Date()): Freshness {
  if (!o.catalogOnline) return 'offline';
  if (o.consecutiveFailures >= FRESHNESS.offlineAfterFailures) return 'offline';
  if (!o.lastFetchedAt) return 'unknown';
  if (ageSeconds(o.lastFetchedAt, now) > FRESHNESS.unknownAfterSeconds) return 'unknown';
  if (ageSeconds(o.lastChangedAt, now) > FRESHNESS.frozenAfterSeconds) return 'stale';
  // A camera can keep re-sending an old picture with a fresh burned-in clock;
  // EXIF capture time catches that when present.
  if (o.lastCaptureAt && ageSeconds(o.lastCaptureAt, o.lastFetchedAt ? new Date(o.lastFetchedAt) : now) > FRESHNESS.exifStaleAfterSeconds) return 'stale';
  return 'live';
}

/**
 * Update frame state after a fetch. `hash` is null when the fetch failed.
 * Returns the new state; persist it as-is.
 */
export function nextFrameState(
  prev: { lastHash: string | null; lastChangedAt: string | null; consecutiveFailures: number },
  hash: string | null,
  fetchedAt: string,
  error: string | null = null,
): { lastHash: string | null; lastFetchedAt: string; lastChangedAt: string | null; consecutiveFailures: number; lastError: string | null } {
  if (!hash) {
    return {
      lastHash: prev.lastHash,
      lastFetchedAt: fetchedAt,
      lastChangedAt: prev.lastChangedAt,
      consecutiveFailures: prev.consecutiveFailures + 1,
      lastError: error ?? 'fetch_failed',
    };
  }
  const changed = hash !== prev.lastHash;
  return {
    lastHash: hash,
    lastFetchedAt: fetchedAt,
    lastChangedAt: changed || !prev.lastChangedAt ? fetchedAt : prev.lastChangedAt,
    consecutiveFailures: 0,
    lastError: null,
  };
}

/** Whether a stored detection may still be shown as current parking. */
export function isDetectionCurrent(
  d: { timestamp: string; freshness: Freshness } | null,
  maxAgeSeconds: number,
  now = new Date(),
): boolean {
  if (!d) return false;
  if (d.freshness !== 'live') return false;
  return ageSeconds(d.timestamp, now) <= maxAgeSeconds;
}

export function secondsSince(iso: string | null, now = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / 1000)) : null;
}

/** "18 sec ago", "3 min ago", "2 hr ago". */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
