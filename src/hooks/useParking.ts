// Main-screen data flow.
//
// 1. GET /api/parking/current and show whatever the server already knows.
// 2. Analyze each watched camera whose result is missing or older than 45 s,
//    nearest first, one at a time, merging each Detection into state so the
//    map and headline update progressively ("Analyzing W 181st St…").
// 3. Re-fetch /api/parking/current for the authoritative summary.
//
// "light" mode (used when returning to the app with manual refresh) skips step 2.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraSummary, Detection, ParkingCurrentResponse } from '../../shared/types';
import { isDetectionCurrent } from '../../shared/freshness';
import { summarize } from '../../shared/status';
import { analyzeCamera, getParkingCurrent, isAbortError, toApiError, type ApiError } from '../lib/api';
import { maxDetectionAge } from '../lib/detection';
import { cameraLabel } from '../lib/format';
import type { AutoRefreshSeconds } from '../lib/prefs';
import { usePageVisible } from './usePageVisible';

/** Re-analyze a watched camera when its latest result is older than this. */
const ANALYZE_AFTER_SECONDS = 45;

export interface ParkingState {
  data: ParkingCurrentResponse | null;
  error: ApiError | null;
  working: boolean;
  /** Progress text while working. */
  message: string | null;
  /** Cameras whose analysis failed during the last refresh. */
  failed: number;
}

/**
 * Fold a fresh Detection into the current response (markers, candidates, headline).
 * Like the server, only watched cameras contribute candidates and the headline;
 * an analysis of any other camera (admin) just updates its marker.
 */
export function mergeDetection(data: ParkingCurrentResponse, det: Detection): ParkingCurrentResponse {
  const update = (c: CameraSummary): CameraSummary =>
    c.id === det.cameraId ? { ...c, latest: det, latestAgeSeconds: 0, frame: { ...c.frame, freshness: det.freshness } } : c;
  const nearby = data.nearby.map(update);
  if (!data.watched.some((c) => c.id === det.cameraId)) return { ...data, nearby };
  const watched = data.watched.map(update);
  const now = new Date();
  const maxAge = maxDetectionAge(data);
  const fresh = isDetectionCurrent(det, maxAge, now) ? det.candidates : [];
  const candidates = [...data.candidates.filter((c) => c.cameraId !== det.cameraId), ...fresh].sort((a, b) => b.confidence - a.confidence);
  const current = watched.filter((c) => c.latest?.status !== 'unknown' && isDetectionCurrent(c.latest, maxAge, now));
  const updatedAt = watched.reduce<string | null>((max, c) => {
    const t = c.latest?.timestamp ?? null;
    return t && (!max || Date.parse(t) > Date.parse(max)) ? t : max;
  }, null);
  return { ...data, watched, nearby, candidates, summary: { ...summarize(candidates, current.length), updatedAt } };
}

export function useParking(autoRefreshSeconds: AutoRefreshSeconds) {
  const [state, setState] = useState<ParkingState>({
    data: null,
    error: null,
    working: true,
    message: 'Checking nearby streets…',
    failed: 0,
  });
  const ctrlRef = useRef<AbortController | null>(null);
  const loadedAt = useRef<number | null>(null);

  const run = useCallback(async (mode: 'full' | 'light') => {
    // One refresh at a time; an aborted controller (unmount) doesn't block.
    if (ctrlRef.current && !ctrlRef.current.signal.aborted) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const { signal } = ctrl;
    // Yield once so callers (effects, timers) never set state synchronously.
    await Promise.resolve();
    setState((s) => ({ ...s, working: true, error: null, message: 'Checking nearby streets…' }));

    let failed = 0;
    try {
      const first = await getParkingCurrent(signal);
      loadedAt.current = Date.now();
      setState((s) => ({ ...s, data: first }));

      const queue =
        mode === 'full'
          ? [...first.watched]
              .filter((c) => c.latestAgeSeconds === null || c.latestAgeSeconds > ANALYZE_AFTER_SECONDS)
              .sort((a, b) => a.distanceMi - b.distanceMi)
          : [];
      for (const cam of queue) {
        setState((s) => ({ ...s, message: `Analyzing ${cameraLabel(cam)}…` }));
        try {
          const det = await analyzeCamera(cam.id, { signal });
          setState((s) => (s.data ? { ...s, data: mergeDetection(s.data, det) } : s));
        } catch (err) {
          if (signal.aborted) throw err;
          failed++;
        }
      }
      if (queue.length) {
        setState((s) => ({ ...s, message: 'Finishing up…' }));
        const final = await getParkingCurrent(signal);
        loadedAt.current = Date.now();
        setState((s) => ({ ...s, data: final }));
      }
      setState((s) => ({ ...s, working: false, message: null, failed }));
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      setState((s) => ({ ...s, working: false, message: null, failed, error: toApiError(err) }));
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
    }
  }, []);

  const refresh = useCallback(() => void run('full'), [run]);

  /** Merge an analysis made elsewhere (camera sheet) so the map stays in sync. */
  const applyDetection = useCallback((det: Detection) => {
    setState((s) => (s.data ? { ...s, data: mergeDetection(s.data, det) } : s));
  }, []);

  // Initial load; abort everything on unmount.
  useEffect(() => {
    void run('full');
    return () => ctrlRef.current?.abort();
  }, [run]);

  // Optional auto-refresh, only while the app is in the foreground.
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible || autoRefreshSeconds === 0) return;
    const id = setInterval(() => void run('full'), autoRefreshSeconds * 1000);
    return () => clearInterval(id);
  }, [visible, autoRefreshSeconds, run]);

  // Returning to the app after a while: don't leave old results on screen.
  useEffect(() => {
    if (!visible) return;
    const last = loadedAt.current;
    if (last !== null && Date.now() - last > 60_000) void run(autoRefreshSeconds ? 'full' : 'light');
  }, [visible, autoRefreshSeconds, run]);

  return { ...state, refresh, applyDetection };
}
