// Detector interfaces. The pipeline depends only on these, so a different
// model or provider can be swapped in without touching the rest of the app.

import type { LaneStates } from '../../shared/curb-gaps';
import type { Calibration, DetectedObject, ParkingAnalysis, ParkingCandidate } from '../../shared/types';

export interface Frame {
  cameraId: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  fetchedAt: string;
  hash: string;
}

/** Finds vehicles in a frame. Boxes are returned in normalized (0..1) coordinates. */
export interface VehicleDetector {
  readonly name: string;
  detect(frame: Frame): Promise<DetectedObject[]>;
}

export interface AnalysisContext {
  calibration: Calibration | null;
  /** Persisted per-lane occupancy grids from earlier checks (evidence is fused over time). */
  laneState?: LaneStates;
  /** @deprecated Superseded by laneState; ignored. */
  previousCandidates?: Pick<ParkingCandidate, 'regionId' | 'gapStart' | 'gapEnd'>[];
  minConfidence: number;
  /** settings.maxDetectionAgeSeconds: evidence older than this must not count as current, so the lane grid forgets it. */
  maxDetectionAgeSeconds?: number;
  camera: { lat: number; lon: number; name: string };
}

/** Turns a frame into a parking verdict. */
export interface ParkingDetector {
  readonly name: string;
  analyze(frame: Frame, context: AnalysisContext): Promise<Omit<ParkingAnalysis, 'freshness'> & { laneState?: LaneStates }>;
}

/** Optional second opinion on a candidate (e.g. a vision LLM). */
export interface CandidateVerifier {
  readonly name: string;
  verify(frame: Frame, candidate: ParkingCandidate): Promise<{ agrees: boolean | null; note: string }>;
}
