// Client for the NYC DOT / TMC camera API (webcams.nyctmc.org).
//
// Catalog: GET {base}/        -> JSON array of cameras (isOnline is the STRING "true"/"false").
// Frame:   GET {base}/{id}/image -> JPEG (usually 352x240), refreshed every 1-4 s.
// Both responses are `cache-control: no-store`; a `?t=` query busts any cache
// in between. JPEGs are never decoded here (10 ms CPU budget): shared/jpeg.ts
// reads the size and EXIF capture time from the headers. Cameras that are
// being serviced return a PNG placeholder (HTTP 200, labelled image/jpeg).

import { inspectJpeg, isPng, TMC_SERVICED_PLACEHOLDER_SHA256, zonedTimeToUtc } from '../shared/jpeg';
import { tmcBaseUrl, type Env } from './env';
import { errorMessage } from './http';
import { CAMERA_ID_PATTERN } from './validation';

const CATALOG_TIMEOUT_MS = 10_000;
const FRAME_TIMEOUT_MS = 8_000;
const MIN_FRAME_BYTES = 2 * 1024;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'ParkNearMe/0.1 (personal street-parking app)';

export type TmcErrorCode = 'timeout' | 'http_error' | 'bad_image' | 'out_of_service' | 'bad_response' | 'network';

export class TmcError extends Error {
  readonly code: TmcErrorCode;
  /** Upstream HTTP status, or 0 when no response was received. */
  readonly status: number;

  constructor(code: TmcErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'TmcError';
    this.code = code;
    this.status = status;
  }
}

export interface CatalogCamera {
  id: string;
  name: string;
  area: string | null;
  lat: number;
  lon: number;
  isOnline: boolean;
}

export interface TmcFrame {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  /** SHA-256 of the JPEG bytes, hex. */
  hash: string;
  fetchedAt: string;
  /** EXIF capture time (UTC ISO) when the camera writes one. */
  capturedAt: string | null;
}

/** AbortSignal.timeout() rejects with a DOMException named TimeoutError (AbortError in some runtimes). */
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

async function tmcFetch(url: string, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': USER_AGENT } });
  } catch (e) {
    throw isTimeout(e)
      ? new TmcError('timeout', `Camera API did not answer within ${timeoutMs / 1000} s`)
      : new TmcError('network', `Camera API unreachable: ${errorMessage(e)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new TmcError('http_error', `Camera API returned HTTP ${res.status}`, res.status);
  }
  return res;
}

/** Map a failure while reading the response body to a TmcError. */
function bodyError(e: unknown): TmcError {
  return isTimeout(e) ? new TmcError('timeout', 'Camera API response timed out') : new TmcError('network', `Camera API response failed: ${errorMessage(e)}`);
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** One catalog entry, or null when it is unusable. */
export function parseCatalogEntry(raw: unknown): CatalogCamera | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const lat = toNumber(o.latitude);
  const lon = toNumber(o.longitude);
  if (typeof o.id !== 'string' || !CAMERA_ID_PATTERN.test(o.id) || lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 200) : o.id;
  const area = typeof o.area === 'string' && o.area.trim() ? o.area.trim().slice(0, 100) : null;
  // The API sends "true"/"false" strings; accept real booleans too. Unknown => online.
  const isOnline = o.isOnline === false || String(o.isOnline).toLowerCase() === 'false' ? false : true;
  return { id: o.id, name, area, lat, lon, isOnline };
}

export async function fetchCatalog(env: Env): Promise<CatalogCamera[]> {
  const res = await tmcFetch(`${tmcBaseUrl(env)}/?t=${Date.now()}`, CATALOG_TIMEOUT_MS);
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw isTimeout(e) ? bodyError(e) : new TmcError('bad_response', 'Camera catalog is not valid JSON', res.status);
  }
  if (!Array.isArray(body)) throw new TmcError('bad_response', 'Camera catalog is not a list', res.status);
  const cameras = body.map(parseCatalogEntry).filter((c): c is CatalogCamera => c !== null);
  if (cameras.length === 0) throw new TmcError('bad_response', 'Camera catalog has no usable cameras', res.status);
  return cameras;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Validate JPEG bytes and wrap them as a frame. Throws TmcError('bad_image' | 'out_of_service'). */
export async function frameFromBytes(bytes: Uint8Array<ArrayBuffer>, fetchedAt: string): Promise<TmcFrame> {
  if (bytes.length > MAX_FRAME_BYTES) throw new TmcError('bad_image', `Camera image too large (${bytes.length} bytes)`);
  const hash = await sha256Hex(bytes);
  if (isPng(bytes) || hash === TMC_SERVICED_PLACEHOLDER_SHA256) throw new TmcError('out_of_service', 'This camera is being serviced right now');
  if (bytes.length < MIN_FRAME_BYTES) throw new TmcError('bad_image', `Camera image too small (${bytes.length} bytes)`);
  const info = inspectJpeg(bytes);
  if (!info) throw new TmcError('bad_image', 'Camera did not return a valid JPEG');
  // Near the fetch time, so the repeated hour when clocks fall back maps to the right occurrence.
  const capturedAt = info.exifDateTime ? zonedTimeToUtc(info.exifDateTime, 'America/New_York', Date.parse(fetchedAt)) : null;
  return { bytes, width: info.width, height: info.height, hash, fetchedAt, capturedAt };
}

export async function fetchFrame(env: Env, cameraId: string): Promise<TmcFrame> {
  if (!CAMERA_ID_PATTERN.test(cameraId)) throw new TmcError('bad_response', 'Invalid camera id');
  const fetchedAt = new Date().toISOString();
  const res = await tmcFetch(`${tmcBaseUrl(env)}/${cameraId}/image?t=${Date.now()}`, FRAME_TIMEOUT_MS);
  const declared = Number(res.headers.get('Content-Length') ?? 0);
  if (declared > MAX_FRAME_BYTES) {
    await res.body?.cancel();
    throw new TmcError('bad_image', `Camera image too large (${declared} bytes)`, res.status);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw bodyError(e);
  }
  const frame = await frameFromBytes(bytes, fetchedAt);
  // A TMC_BASE_URL override serves recorded frames (dev fixtures); their camera clock is long past.
  return env.TMC_BASE_URL ? { ...frame, capturedAt: null } : frame;
}
