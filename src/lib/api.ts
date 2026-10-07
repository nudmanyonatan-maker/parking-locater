// Typed client for the ParkNearMe Worker API (same origin, under /api).
// Every call has a timeout, attaches the admin token when one is unlocked,
// and turns failures into ApiError with a message that is safe to show.

import type {
  AppSettings,
  ApiError as ApiErrorBody,
  Calibration,
  CameraDetail,
  CarSpot,
  CameraPreference,
  CameraSummary,
  Detection,
  DetectionHistoryItem,
  Freshness,
  HealthResponse,
  ParkingCurrentResponse,
  PushConfigResponse,
  Region,
  Usefulness,
} from '../../shared/types';
import type { SettingsPatch } from '../../shared/settings';
import { getPrefs } from './prefs';

export class ApiError extends Error {
  /** HTTP status, or 0 for network failures and timeouts. */
  readonly status: number;
  /** Machine-readable code from the server (e.g. "unauthorized"), or "network" / "timeout". */
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Normalize anything thrown into an ApiError (keeps AbortErrors out: check isAbortError first). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return new ApiError(0, 'client_error', err.message || 'Something went wrong.');
  return new ApiError(0, 'client_error', 'Something went wrong.');
}

const FRIENDLY: Record<string, string> = {
  unauthorized: 'Admin token was rejected. Unlock again in Settings.',
  admin_not_configured: 'Admin is not configured on the server (ADMIN_TOKEN secret missing).',
  not_watched: 'Only watched cameras can be analyzed without admin.',
  camera_timeout: 'The camera took too long to answer.',
  camera_unavailable: 'The camera is not sending images right now.',
  bad_image: 'The camera sent a broken image.',
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override the stored admin token (used to verify a token before saving it). */
  token?: string | null;
}

/** Combine a caller's signal with a timeout. AbortSignal.any is too new for older iOS. */
function timeoutSignal(outer: AbortSignal | undefined, ms: number) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

async function send(path: string, opts: RequestOptions, accept: string): Promise<Response> {
  const { method = 'GET', body, signal, timeoutMs = 15_000 } = opts;
  const token = opts.token !== undefined ? opts.token : getPrefs().adminToken;
  const headers: Record<string, string> = { Accept: accept };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const t = timeoutSignal(signal, timeoutMs);
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: t.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw await errorFrom(res);
    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (t.timedOut()) throw new ApiError(0, 'timeout', 'The server took too long to respond.');
    if (signal?.aborted || isAbortError(err)) throw err;
    throw new ApiError(0, 'network', "Can't reach the server. Check your connection.");
  } finally {
    t.done();
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    body = null;
  }
  const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
  const message =
    FRIENDLY[code] ??
    (typeof body?.message === 'string' && body.message
      ? body.message
      : res.status >= 500
        ? 'The server had a problem. Try again.'
        : `Request failed (${res.status}).`);
  return new ApiError(res.status, code, message, body?.details);
}

async function json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts, 'application/json');
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The server sent an unexpected response.');
  }
}

const enc = encodeURIComponent;

// ---- Parking & cameras ----------------------------------------------------

export const getParkingCurrent = (signal?: AbortSignal) => json<ParkingCurrentResponse>('/parking/current', { signal });

export const getCameras = (signal?: AbortSignal) => json<CameraSummary[]>('/cameras', { signal });

export const getCamera = (id: string, signal?: AbortSignal) => json<CameraDetail>(`/cameras/${enc(id)}`, { signal });

export const getHistory = (id: string, limit = 30, signal?: AbortSignal) =>
  json<DetectionHistoryItem[]>(`/cameras/${enc(id)}/history?limit=${limit}`, { signal });

/** Runs (or, inside the cooldown, returns the latest) analysis. Can take a while: detector + frame fetch. */
export const analyzeCamera = (id: string, opts: { force?: boolean; signal?: AbortSignal } = {}) =>
  json<Detection>(`/cameras/${enc(id)}/analyze${opts.force ? '?force=1' : ''}`, { method: 'POST', signal: opts.signal, timeoutMs: 45_000 });

export const setUsefulness = (id: string, body: { usefulness: Usefulness; notes?: string; streetLabel?: string }) =>
  json<CameraPreference>(`/cameras/${enc(id)}/usefulness`, { method: 'POST', body });

export const syncCameras = () => json<{ count?: number }>('/cameras/sync', { method: 'POST', timeoutMs: 30_000 });

// ---- Calibration -----------------------------------------------------------

export const getCalibration = (id: string, signal?: AbortSignal) => json<Calibration | null>(`/cameras/${enc(id)}/calibration`, { signal });

export const saveCalibration = (id: string, body: { regions: Region[]; referenceWidth: number; referenceHeight: number }) =>
  json<Calibration>(`/cameras/${enc(id)}/calibration`, { method: 'POST', body });

export const deleteCalibration = (id: string) => json<{ ok: boolean }>(`/cameras/${enc(id)}/calibration`, { method: 'DELETE' });

// ---- Frames ----------------------------------------------------------------

export interface FrameBlob {
  blob: Blob;
  /** When the Worker fetched the frame from the camera (ms epoch). */
  fetchedAt: number;
  freshness: Freshness | null;
}

const FRESHNESS_VALUES: Freshness[] = ['live', 'stale', 'offline', 'unknown'];

/** Fetch the current camera frame. `?t=` defeats any intermediate cache. */
export async function fetchFrame(id: string, signal?: AbortSignal): Promise<FrameBlob> {
  const res = await send(`/cameras/${enc(id)}/image?t=${Date.now()}`, { signal, timeoutMs: 12_000 }, 'image/jpeg,image/*');
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new ApiError(res.status, 'bad_image', FRIENDLY.bad_image!);
  const blob = await res.blob();
  const fetchedHeader = Date.parse(res.headers.get('x-frame-fetched-at') ?? '');
  const freshness = res.headers.get('x-frame-freshness') as Freshness | null;
  return {
    blob,
    fetchedAt: Number.isFinite(fetchedHeader) ? fetchedHeader : Date.now(),
    freshness: freshness && FRESHNESS_VALUES.includes(freshness) ? freshness : null,
  };
}

// ---- Settings, auth, health ------------------------------------------------

export const getSettings = (signal?: AbortSignal) => json<AppSettings>('/settings', { signal });

export const putSettings = (patch: SettingsPatch) => json<AppSettings>('/settings', { method: 'PUT', body: patch });

export const geocodeHome = () => json<AppSettings>('/settings/geocode', { method: 'POST', timeoutMs: 30_000 });

/** Resolves when `token` is accepted by the server; rejects with ApiError otherwise. */
export const checkAdminToken = (token: string) => json<{ ok: boolean }>('/auth/check', { token });

export const getHealth = (signal?: AbortSignal) => json<HealthResponse>('/health', { signal });

// ---- Push ------------------------------------------------------------------

export const getPushConfig = (signal?: AbortSignal) => json<PushConfigResponse>('/push/config', { signal });

export const pushSubscribe = (sub: PushSubscriptionJSON) => json<{ ok: boolean }>('/push/subscribe', { method: 'POST', body: sub });

export const pushUnsubscribe = (endpoint: string) => json<{ ok: boolean }>('/push/unsubscribe', { method: 'POST', body: { endpoint } });

export const pushTest = () => json<{ sent: number; failed: number }>('/push/test', { method: 'POST', timeoutMs: 30_000 });

// ---- Where's my car -------------------------------------------------------

export const getSpot = (signal?: AbortSignal) => json<CarSpot | null>('/spot', { signal });

export const saveSpot = (spot: Pick<CarSpot, 'lat' | 'lng' | 'note' | 'moveBy'> & { faceId?: string | null }) =>
  json<CarSpot>('/spot', { method: 'PUT', body: spot });

export const clearSpot = () => json<{ ok: boolean }>('/spot', { method: 'DELETE' });
