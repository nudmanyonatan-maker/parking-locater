// Camera frames: fetched from TMC, shared for 3 s through the Workers Cache
// API (so several viewers, or an analysis right after a view, cost one
// upstream request), and tracked in camera_frame_state for LIVE / STALE /
// OFFLINE. Concurrent requests for the same camera in one isolate share one
// load, so simultaneous cache misses make one upstream request.
//
// Frames from live cameras change every 1-4 s (burned-in clock), so the state
// row is rewritten only after a failure, when recovering from one, or when the
// stored row is more than 10 s old. Freshness thresholds are minutes, so the
// lag is harmless and D1 writes stay low.

import { frameFreshness, nextFrameState } from '../../shared/freshness';
import type { Camera, FrameState } from '../../shared/types';
import type { Frame } from '../analysis/detector';
import { getFrameStateRow, putFrameState, type FrameStateRow, type StoredFrameState } from '../db';
import type { Env } from '../env';
import { errorMessage, type Background } from '../http';
import { InFlight } from '../inflight';
import { fetchFrame, TmcError } from '../tmc';

const CACHE_ORIGIN = 'https://frames.parknearme.internal';
const CACHE_TTL_SECONDS = 3;
const STATE_WRITE_INTERVAL_MS = 10_000;

export type CameraFrameBytes = Frame & { bytes: Uint8Array<ArrayBuffer>; capturedAt: string | null };

export interface CameraFrame {
  frame: CameraFrameBytes;
  state: FrameState;
}

function toFrameState(s: Omit<StoredFrameState, 'lastFetchedAt'> & { lastFetchedAt: string | null }, catalogOnline: boolean, now = new Date()): FrameState {
  return {
    lastHash: s.lastHash,
    lastFetchedAt: s.lastFetchedAt,
    lastChangedAt: s.lastChangedAt,
    consecutiveFailures: s.consecutiveFailures,
    lastError: s.lastError,
    freshness: frameFreshness({ catalogOnline, ...s }, now),
  };
}

export function frameStateFromRow(row: FrameStateRow | null | undefined, catalogOnline: boolean, now = new Date()): FrameState {
  return toFrameState(
    {
      lastHash: row?.last_hash ?? null,
      lastFetchedAt: row?.last_fetched_at ?? null,
      lastChangedAt: row?.last_changed_at ?? null,
      consecutiveFailures: row?.consecutive_failures ?? 0,
      lastError: row?.last_error ?? null,
      lastCaptureAt: row?.last_capture_at ?? null,
    },
    catalogOnline,
    now,
  );
}

function frameCache(): Cache | null {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

async function readCachedFrame(cache: Cache, key: string, cameraId: string): Promise<CameraFrameBytes | null> {
  const hit = await cache.match(key);
  if (!hit) return null;
  const width = Number(hit.headers.get('X-Frame-Width'));
  const height = Number(hit.headers.get('X-Frame-Height'));
  const hash = hit.headers.get('X-Frame-Hash');
  const fetchedAt = hit.headers.get('X-Frame-Fetched-At');
  if (!hash || !fetchedAt || !(width > 0) || !(height > 0)) return null;
  const capturedAt = hit.headers.get('X-Frame-Captured-At');
  return { cameraId, bytes: new Uint8Array(await hit.arrayBuffer()), width, height, hash, fetchedAt, capturedAt };
}

function cacheResponse(frame: CameraFrameBytes): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'image/jpeg',
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    'X-Frame-Width': String(frame.width),
    'X-Frame-Height': String(frame.height),
    'X-Frame-Hash': frame.hash,
    'X-Frame-Fetched-At': frame.fetchedAt,
  };
  if (frame.capturedAt) headers['X-Frame-Captured-At'] = frame.capturedAt;
  return new Response(frame.bytes, { headers });
}

function shouldWriteState(prev: FrameStateRow | null, now: number): boolean {
  if (!prev?.last_fetched_at || prev.consecutive_failures > 0) return true;
  return now - Date.parse(prev.last_fetched_at) > STATE_WRITE_INTERVAL_MS;
}

/** Frame loads running in this isolate, per database and camera. */
const frameLoads = new InFlight<CameraFrame>();

/** Current frame for a stored camera. Throws TmcError when the camera can't be fetched. */
export function getFrameCached(env: Env, ctx: Background, camera: Pick<Camera, 'id' | 'catalogOnline'>): Promise<CameraFrame> {
  return frameLoads.run(env.DB, camera.id, ctx, () => loadFrame(env, ctx, camera));
}

async function loadFrame(env: Env, ctx: Background, camera: Pick<Camera, 'id' | 'catalogOnline'>): Promise<CameraFrame> {
  const cache = frameCache();
  const key = `${CACHE_ORIGIN}/${camera.id}`;
  const [prevRow, cached] = await Promise.all([getFrameStateRow(env.DB, camera.id), cache ? readCachedFrame(cache, key, camera.id) : null]);
  if (cached) return { frame: cached, state: frameStateFromRow(prevRow, camera.catalogOnline) };

  const prev = {
    lastHash: prevRow?.last_hash ?? null,
    lastChangedAt: prevRow?.last_changed_at ?? null,
    consecutiveFailures: prevRow?.consecutive_failures ?? 0,
  };
  let frame: CameraFrameBytes;
  try {
    frame = { cameraId: camera.id, ...(await fetchFrame(env, camera.id)) };
  } catch (e) {
    const reason = e instanceof TmcError ? `${e.code}: ${e.message}` : errorMessage(e);
    const failed = nextFrameState(prev, null, new Date().toISOString(), reason.slice(0, 200));
    await putFrameState(env.DB, camera.id, { ...failed, lastCaptureAt: prevRow?.last_capture_at ?? null });
    throw e;
  }

  const next: StoredFrameState = { ...nextFrameState(prev, frame.hash, frame.fetchedAt), lastCaptureAt: frame.capturedAt };
  if (shouldWriteState(prevRow, Date.now())) await putFrameState(env.DB, camera.id, next);
  if (cache) {
    ctx.waitUntil(cache.put(key, cacheResponse(frame)).catch((e: unknown) => console.error(`frames: cache put failed for ${camera.id}: ${errorMessage(e)}`)));
  }
  return { frame, state: toFrameState(next, camera.catalogOnline) };
}
