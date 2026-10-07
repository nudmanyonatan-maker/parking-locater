// One analysis run for one camera: cooldown, frame fetch, freshness gate,
// calibration gate, vehicle detection + curb-gap analysis, optional VLM second
// opinion, then persist and (in the background) evaluate push alerts.
//
// The cooldown is enforced with an atomic claim in D1 (analysis_slots) taken
// before any upstream fetch or AI call, so a burst of concurrent requests
// costs one analysis. Concurrent callers in the same isolate share that run.
//
// Every outcome is stored as a detection, including failures (status
// "unknown" with a machine-readable reason), so history shows why a check
// produced nothing. AI is only called for live frames.

import type { LaneStates } from '../../shared/curb-gaps';
import { secondsSince } from '../../shared/freshness';
import type { AppSettings, Calibration, Camera, Detection, Freshness, ParkingAnalysis } from '../../shared/types';
import { createVehicleDetector, CurbGapParkingDetector } from '../analysis/detectors';
import { applyVerdict, GemmaCandidateVerifier } from '../analysis/vlm';
import { claimAnalysisSlot, getCalibrationRow, getLaneState, insertDetection, putLaneState, recentDetections, toCalibration } from '../db';
import type { Env } from '../env';
import { errorMessage, HttpError, type Background } from '../http';
import { InFlight } from '../inflight';
import { TmcError } from '../tmc';
import { evaluateAlerts } from './alerts';
import { hasParkingLane, requireCamera } from './cameras';
import { getFrameCached, type CameraFrameBytes } from './frames';
import { readSettings } from './settings';

/** Even a forced admin analysis waits this long after the previous one. */
const ADMIN_FORCE_MIN_SECONDS = 5;
/** VLM second opinions per analysis (each costs ~5-13 neurons). */
const MAX_VERIFIED_CANDIDATES = 2;
const MAX_ERROR_LENGTH = 300;

const SKIP_REASON: Record<Exclude<Freshness, 'live'>, string> = {
  stale: 'stale_frame',
  offline: 'camera_offline',
  unknown: 'frame_unavailable',
};

export interface AnalyzeOptions {
  /** Admin only: bypass the cooldown (still at least 5 s apart). */
  force?: boolean;
  /** Admin callers may analyze uncalibrated cameras (to preview detections). */
  admin?: boolean;
}

interface AnalysisInput {
  settings: AppSettings;
  calibration: Calibration | null;
  laneState: LaneStates | undefined;
  admin: boolean;
}

interface AnalysisOutput {
  analysis: ParkingAnalysis;
  /** Updated curb occupancy grids to persist, when the detector ran. */
  laneState?: LaneStates;
}

const truncate = (s: string, n = MAX_ERROR_LENGTH) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Minimum seconds between two analyses of a camera for this caller. */
function cooldownSeconds(settings: AppSettings, opts: AnalyzeOptions): number {
  return opts.admin && opts.force ? ADMIN_FORCE_MIN_SECONDS : settings.analysisCooldownSeconds;
}

function inCooldown(latest: Detection, settings: AppSettings, opts: AnalyzeOptions): boolean {
  const age = secondsSince(latest.timestamp) ?? Infinity;
  return age < cooldownSeconds(settings, opts);
}

/** An analysis that stopped before (or instead of) running the detector. */
function skipped(cameraId: string, reason: string, fields: Partial<ParkingAnalysis> = {}): ParkingAnalysis {
  return {
    cameraId,
    timestamp: new Date().toISOString(),
    frameFetchedAt: null,
    frameHash: null,
    freshness: 'unknown',
    detector: 'none',
    vehiclesDetected: 0,
    parkedVehicles: 0,
    candidateSpaces: 0,
    confidence: 0,
    status: 'unknown',
    reason,
    objects: [],
    candidates: [],
    notes: [],
    error: null,
    ...fields,
  };
}

/** Ask the vision LLM about the best candidates and fold its verdicts in. Failures only add a note. */
async function verifyCandidates(ai: Ai, frame: CameraFrameBytes, result: ParkingAnalysis, minConfidence: number): Promise<ParkingAnalysis> {
  if (result.candidates.length === 0) return result;
  const verifier = new GemmaCandidateVerifier(ai);
  const top = result.candidates.slice(0, MAX_VERIFIED_CANDIDATES);
  const verdicts = await Promise.allSettled(top.map((c) => verifier.verify(frame, c)));
  const notes = [...result.notes];
  const candidates = result.candidates.map((c, i) => {
    const v = verdicts[i];
    if (!v) return c;
    if (v.status === 'fulfilled') return applyVerdict(c, v.value.agrees, v.value.note, minConfidence);
    notes.push(`Vision check failed: ${truncate(errorMessage(v.reason), 120)}`);
    return c;
  });
  candidates.sort((a, b) => b.confidence - a.confidence);
  return {
    ...result,
    detector: `${result.detector}+${verifier.name}`,
    candidates,
    notes,
    status: candidates.some((c) => c.status === 'likely_available') ? 'likely_available' : 'possible',
    confidence: candidates[0]!.confidence,
  };
}

async function runAnalysis(env: Env, ctx: Background, camera: Camera, input: AnalysisInput): Promise<AnalysisOutput> {
  const skip = (reason: string, fields: Partial<ParkingAnalysis> = {}): AnalysisOutput => ({ analysis: skipped(camera.id, reason, fields) });
  let fetched;
  try {
    fetched = await getFrameCached(env, ctx, camera);
  } catch (e) {
    if (!(e instanceof TmcError)) throw e;
    return skip('frame_unavailable', { freshness: e.code === 'timeout' ? 'unknown' : 'offline', error: truncate(e.message) });
  }
  const { frame, state } = fetched;
  const frameInfo: Partial<ParkingAnalysis> = { frameFetchedAt: frame.fetchedAt, frameHash: frame.hash, freshness: state.freshness };
  if (state.freshness !== 'live') return skip(SKIP_REASON[state.freshness], frameInfo);

  // Without a parking lane there is nothing to measure; only admins (previewing boxes) pay for detection.
  if (!hasParkingLane(input.calibration) && !input.admin) {
    return skip('needs_calibration', { ...frameInfo, notes: ['No parking lane is calibrated for this camera.'] });
  }
  const vehicles = createVehicleDetector(env);
  if (!vehicles) return skip('detector_unavailable', { ...frameInfo, notes: ['Workers AI binding is not configured.'] });

  const detector = new CurbGapParkingDetector(vehicles);
  try {
    const { laneState, ...result } = await detector.analyze(frame, {
      calibration: input.calibration,
      laneState: input.laneState,
      minConfidence: input.settings.minConfidence,
      maxDetectionAgeSeconds: input.settings.maxDetectionAgeSeconds,
      camera: { lat: camera.lat, lon: camera.lon, name: camera.name },
    });
    const analysis: ParkingAnalysis = { ...result, freshness: state.freshness };
    return {
      analysis: input.settings.vlmVerify && env.AI ? await verifyCandidates(env.AI, frame, analysis, input.settings.minConfidence) : analysis,
      laneState,
    };
  } catch (e) {
    console.error(`analyze ${camera.id}: detector failed: ${errorMessage(e)}`);
    return skip('detector_error', { ...frameInfo, detector: detector.name, error: truncate(errorMessage(e)) });
  }
}

/** Analyses running in this isolate, per database and camera. */
const analyses = new InFlight<Detection>();

/**
 * Analyze a stored camera and persist the result. Inside the cooldown the
 * latest stored detection is returned unchanged (no frame fetch, no AI call).
 * A caller arriving while the same camera is being analyzed in this isolate
 * gets that run's result.
 * Throws HttpError 404 for unknown cameras, and 429 when another isolate holds
 * the slot of a camera that has no stored detection yet.
 */
export function analyzeCamera(env: Env, ctx: Background, cameraId: string, opts: AnalyzeOptions = {}): Promise<Detection> {
  return analyses.run(env.DB, cameraId, ctx, () => analyzeOnce(env, ctx, cameraId, opts));
}

async function analyzeOnce(env: Env, ctx: Background, cameraId: string, opts: AnalyzeOptions): Promise<Detection> {
  const camera = await requireCamera(env, cameraId);
  const [settings, recent] = await Promise.all([readSettings(env), recentDetections(env.DB, cameraId, 1)]);
  const latest = recent[0] ?? null;
  if (latest && inCooldown(latest, settings, opts)) return latest;

  // Claim the slot before any upstream fetch or AI call. Only one concurrent
  // caller wins; the others get the newest stored result, as in the cooldown.
  const now = Date.now();
  const cutoff = new Date(now - cooldownSeconds(settings, opts) * 1000).toISOString();
  if (!(await claimAnalysisSlot(env.DB, cameraId, new Date(now).toISOString(), cutoff))) {
    const [newest] = await recentDetections(env.DB, cameraId, 1);
    if (newest) return newest;
    throw new HttpError(429, 'analysis_in_progress', 'This camera is being analyzed right now. Try again in a few seconds.');
  }

  // Read after the claim, so an analysis that just finished elsewhere is built upon.
  const [calibrationRow, laneState] = await Promise.all([getCalibrationRow(env.DB, cameraId), getLaneState(env.DB, cameraId)]);
  const calibration = calibrationRow ? toCalibration(calibrationRow) : null;
  const out = await runAnalysis(env, ctx, camera, { settings, calibration, laneState, admin: !!opts.admin });
  const [detection] = await Promise.all([
    insertDetection(env.DB, out.analysis),
    out.laneState && Object.keys(out.laneState).length ? putLaneState(env.DB, cameraId, out.laneState, new Date().toISOString()) : null,
  ]);
  console.log(
    `analyze ${cameraId}: #${detection.id} ${detection.status}${detection.reason ? ` (${detection.reason})` : ''}, ` +
      `${detection.vehiclesDetected} vehicles, ${detection.candidateSpaces} spaces, ${detection.freshness}, ${detection.detector}`,
  );
  ctx.waitUntil(evaluateAlerts(env, detection).catch((e: unknown) => console.error(`alerts: ${errorMessage(e)}`)));
  return detection;
}
