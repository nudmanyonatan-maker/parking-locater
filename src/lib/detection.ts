// Interpreting detections for display. Old or non-live results are never
// presented as current parking.

import type {
  CameraSummary,
  Detection,
  DetectionHistoryItem,
  ParkingCandidate,
  ParkingCurrentResponse,
  ParkingStatus,
} from '../../shared/types';
import { isDetectionCurrent } from '../../shared/freshness';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { ageSeconds, STATUS_TONE, type Tone } from './format';

/** Client-side fallback matching the server default (settings.maxDetectionAgeSeconds). */
export const MAX_DETECTION_AGE_SECONDS = DEFAULT_SETTINGS.maxDetectionAgeSeconds;

/** The server's configured age limit when the response carries it, else the default. */
export function maxDetectionAge(data: Pick<ParkingCurrentResponse, 'maxDetectionAgeSeconds'> | null | undefined): number {
  const v = data?.maxDetectionAgeSeconds;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : MAX_DETECTION_AGE_SECONDS;
}

export function isCurrent(
  det: { timestamp: string; freshness: Detection['freshness'] } | null | undefined,
  nowMs: number,
  maxAgeSeconds = MAX_DETECTION_AGE_SECONDS,
): boolean {
  return isDetectionCurrent(det ?? null, maxAgeSeconds, new Date(nowMs));
}

export interface ShownCandidate {
  candidate: ParkingCandidate;
  ageSeconds: number | null;
}

/** Candidates that are still current on this device's clock (the server filtered at response time). */
export function currentCandidates(data: ParkingCurrentResponse, now: number): ShownCandidate[] {
  const byId = new Map(data.watched.map((c) => [c.id, c]));
  const maxAge = maxDetectionAge(data);
  const out: ShownCandidate[] = [];
  for (const candidate of data.candidates) {
    const latest = byId.get(candidate.cameraId)?.latest ?? null;
    if (latest) {
      if (!isCurrent(latest, now, maxAge)) continue;
      out.push({ candidate, ageSeconds: ageSeconds(latest.timestamp, now) });
    } else {
      const age = ageSeconds(data.generatedAt, now);
      if (age !== null && age > maxAge) continue;
      out.push({ candidate, ageSeconds: null });
    }
  }
  return out;
}

/**
 * Status dot for a camera's map marker: only watched cameras get one, and an
 * old or non-live result shows as `unknown` (gray), never as current parking.
 */
export function cameraMarkerStatus(
  cam: Pick<CameraSummary, 'latest'>,
  watched: boolean,
  nowMs: number,
  maxAgeSeconds = MAX_DETECTION_AGE_SECONDS,
): ParkingStatus | null {
  if (!watched || !cam.latest) return null;
  return isCurrent(cam.latest, nowMs, maxAgeSeconds) ? cam.latest.status : 'unknown';
}

const SHORT_REASON: Record<string, string> = {
  needs_calibration: 'Not calibrated',
  stale_frame: 'Frozen image',
  frame_unavailable: 'Offline',
  detector_unavailable: 'No analysis',
  detector_error: 'Analysis failed',
  no_vehicles_detected: 'No cars seen',
};

/** Compact chip for camera thumbnails: tone + a couple of words. */
export function detectionChip(
  det: Detection | null,
  nowMs: number,
  maxAgeSeconds = MAX_DETECTION_AGE_SECONDS,
): { tone: Tone; text: string } {
  if (!det) return { tone: 'gray', text: 'Not checked' };
  if (!isCurrent(det, nowMs, maxAgeSeconds)) return { tone: 'gray', text: 'Old result' };
  if (det.status === 'likely_available' || det.status === 'possible') {
    const n = det.candidateSpaces;
    return { tone: STATUS_TONE[det.status], text: `${n} ${n === 1 ? 'spot' : 'spots'}` };
  }
  if (det.status === 'none') return { tone: 'red', text: 'No spots' };
  return { tone: 'gray', text: (det.reason && SHORT_REASON[det.reason]) || 'Unknown' };
}

/** "1 possible spot", "no spots", "Not calibrated yet" for history rows. */
export function historySummary(h: Pick<DetectionHistoryItem, 'status' | 'candidateSpaces' | 'reason'>): string {
  if (h.status === 'likely_available' || h.status === 'possible') {
    return `${h.candidateSpaces} possible ${h.candidateSpaces === 1 ? 'spot' : 'spots'}`;
  }
  if (h.status === 'none') return 'no spots';
  return (h.reason && SHORT_REASON[h.reason]?.toLowerCase()) || 'unknown';
}
