// Live camera frame as an object URL, refreshed on an interval.
//
// Frames are fetched with fetch() (not <img src>) so we can read the
// X-Frame-Fetched-At / X-Frame-Freshness headers and keep showing the last good
// frame when a refresh fails instead of a broken-image icon.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFrame, isAbortError, toApiError, type ApiError } from '../lib/api';
import type { Freshness } from '../../shared/types';

export interface FrameState {
  /** Object URL of the newest good frame. */
  src: string | null;
  /** When the server fetched that frame from the camera (ms). */
  fetchedAt: number | null;
  freshness: Freshness | null;
  /** Error from the most recent attempt (the previous frame stays visible). */
  error: ApiError | null;
  /** Natural pixel size of the newest frame. */
  width: number | null;
  height: number | null;
}

interface Options {
  /** Refresh period; 0 = load once. */
  intervalMs: number;
  /** When false, no requests are made (hidden, paused, off-screen). */
  active: boolean;
  /** Delay before the first request, to stagger many cards. */
  initialDelayMs?: number;
}

const EMPTY: FrameState = { src: null, fetchedAt: null, freshness: null, error: null, width: null, height: null };

function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

export function useFrame(cameraId: string | null, { intervalMs, active, initialDelayMs = 0 }: Options) {
  const [state, setState] = useState<FrameState & { cameraId: string | null }>({ ...EMPTY, cameraId: null });
  const [nonce, setNonce] = useState(0);
  const firstRun = useRef(true);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    if (!cameraId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;

    const tick = async () => {
      ctrl = new AbortController();
      try {
        const frame = await fetchFrame(cameraId, ctrl.signal);
        const url = URL.createObjectURL(frame.blob);
        const size = await imageSize(url);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        urls.current.push(url);
        // Revoke older frames a moment later, once React has swapped the <img>.
        while (urls.current.length > 2) {
          const old = urls.current.shift();
          if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
        }
        setState({
          cameraId,
          src: url,
          fetchedAt: frame.fetchedAt,
          freshness: frame.freshness,
          error: null,
          width: size.width || null,
          height: size.height || null,
        });
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        setState((s) => (s.cameraId === cameraId ? { ...s, error: toApiError(err) } : { ...EMPTY, cameraId, error: toApiError(err) }));
      }
      if (!cancelled && intervalMs > 0) timer = setTimeout(tick, intervalMs);
    };

    const delay = firstRun.current ? initialDelayMs : 0;
    firstRun.current = false;
    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl?.abort();
    };
  }, [cameraId, active, intervalMs, initialDelayMs, nonce]);

  // Free every object URL on unmount.
  useEffect(() => {
    const list = urls.current;
    return () => {
      for (const u of list) URL.revokeObjectURL(u);
      list.length = 0;
    };
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const frame: FrameState = state.cameraId === cameraId ? state : EMPTY;
  return { ...frame, reload };
}
