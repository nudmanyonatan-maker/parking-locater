// The one answer on the main screen: is there a spot my car fits in, and where.

import { spotFacts, type SpotFacts } from '../../shared/curb-gaps';
import type { CameraSummary, ParkingCandidate, ParkingCurrentResponse, Region } from '../../shared/types';
import { currentCandidates, isCurrent, maxDetectionAge } from './detection';
import { ageSeconds, cameraLabel, reasonText } from './format';

export type AnswerTone = 'yes' | 'maybe' | 'no' | 'unknown';

export interface Spot {
  candidate: ParkingCandidate;
  facts: SpotFacts;
}

export interface Answer {
  tone: AnswerTone;
  title: string;
  detail: string;
  /** Best opening, if any. */
  spot: Spot | null;
  /** Every current opening, best first (to outline on the camera). */
  spots: Spot[];
  /** Camera to show: the best spot's camera, else the nearest watched one. */
  camera: CameraSummary | null;
}

/** `lanes` = parking regions per camera id (from each camera's calibration). */
export function answerFor(data: ParkingCurrentResponse, lanes: Record<string, Region[]>, nowMs: number): Answer {
  const laneFor = (c: ParkingCandidate) => lanes[c.cameraId]?.find((r) => r.id === c.regionId);
  const spots: Spot[] = currentCandidates(data, nowMs).map(({ candidate }) => ({ candidate, facts: spotFacts(candidate, laneFor(candidate)) }));
  // Spots the car fits in first, then the most confident.
  spots.sort((a, b) => Number(b.facts.fits) - Number(a.facts.fits) || b.candidate.confidence - a.candidate.confidence);
  const nearest = [...data.watched].sort((a, b) => a.distanceMi - b.distanceMi)[0] ?? null;
  const cameraOf = (s: Spot | undefined) => data.watched.find((c) => c.id === s?.candidate.cameraId) ?? nearest;

  const sure = spots.filter((s) => s.candidate.status === 'likely_available' && s.facts.fits);
  if (sure.length) {
    const n = sure.reduce((sum, s) => sum + s.candidate.spaces, 0);
    return { tone: 'yes', title: `Yes, ${n} open ${n === 1 ? 'spot' : 'spots'}`, detail: sure[0]!.candidate.streetLabel, spot: sure[0]!, spots, camera: cameraOf(sure[0]) };
  }
  if (spots.length) {
    return { tone: 'maybe', title: 'Maybe. Check the camera', detail: spots[0]!.candidate.streetLabel, spot: spots[0]!, spots, camera: cameraOf(spots[0]) };
  }

  const maxAge = maxDetectionAge(data);
  const latest = nearest?.latest ?? null;
  if (latest && latest.status !== 'unknown' && isCurrent(latest, nowMs, maxAge)) {
    return { tone: 'no', title: 'No open spots', detail: `${nearest!.preference.streetLabel ?? 'The curb'} looks full`, spot: null, spots, camera: nearest };
  }
  // A recent check that couldn't decide still says why (camera offline, too dark…).
  const age = ageSeconds(latest?.timestamp, nowMs);
  const why = age !== null && age <= maxAge ? reasonText(latest!.reason) : null;
  return { tone: 'unknown', title: "Can't tell right now", detail: why ?? 'No recent camera check', spot: null, spots, camera: nearest };
}

/** Street cameras worth a look: within ~5 blocks of home (the next ones out are expressways). */
export const LOOK_RADIUS_MI = 0.3;

/** Cameras to flip between: watched (parking-checked) ones first, then other nearby online ones, nearest first. */
export function lookCameras(data: Pick<ParkingCurrentResponse, 'watched' | 'nearby'>): CameraSummary[] {
  const watched = new Set(data.watched.map((c) => c.id));
  const others = data.nearby.filter((c) => !watched.has(c.id) && c.catalogOnline && c.distanceMi <= LOOK_RADIUS_MI);
  const byDistance = (a: CameraSummary, b: CameraSummary) => a.distanceMi - b.distanceMi;
  return [...[...data.watched].sort(byDistance), ...others.sort(byDistance)];
}

/** Short tab label: "W 181st" from "W 181st St, Audubon → Amsterdam"; "St Nicholas" from "St Nicholas Ave @ 181 St". */
export function shortCameraLabel(cam: Pick<CameraSummary, 'name' | 'preference'>): string {
  const street = cameraLabel(cam).split(/,| near /)[0]!.trim();
  return street.replace(/\s+(Ave|Avenue|St|Street)$/i, '') || street;
}
