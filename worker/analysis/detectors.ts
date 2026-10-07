// Concrete detectors.
//
// WorkersAiDetrDetector     - COCO boxes from @cf/facebook/detr-resnet-50. Cheapest
//                             (~0.7 neurons/call) but dropped from the public
//                             catalog in Sept 2026; may stop working.
// WorkersAiMoondreamDetector - open-vocabulary "detect" from Moondream 3.1, the
//                             supported replacement (~20-30 neurons/call, no scores).
// FallbackVehicleDetector   - tries detectors in order, remembers the first that works.
// FixtureVehicleDetector    - dev only: replays detections recorded in GitHub Actions
//                             (DETR run offline on real frames) keyed by frame hash.
// CurbGapParkingDetector    - ParkingDetector: vehicles + calibration -> open curb.

import { analyzeCurbGaps, DEFAULT_GAP_OPTIONS } from '../../shared/curb-gaps';
import type { ParkingCandidate } from '../../shared/types';
import type { Env } from '../env';
import type { AnalysisContext, Frame, ParkingDetector, VehicleDetector } from './detector';
import { cleanVehicles, parseObjectDetections } from './vehicles';

export const DETR_MODEL = '@cf/facebook/detr-resnet-50';
export const MOONDREAM_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
/** Moondream returns boxes without scores; treat them as fairly confident. */
const MOONDREAM_SCORE = 0.8;

type LooseAi = { run(model: string, input: unknown): Promise<unknown> };

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Detector boxes below this score are discarded. Fairly low because the lane grid fuses evidence over time. */
export const MIN_VEHICLE_SCORE = 0.35;

export class WorkersAiDetrDetector implements VehicleDetector {
  readonly name = 'workers-ai/detr-resnet-50';
  private readonly ai: Ai;
  constructor(ai: Ai) {
    this.ai = ai;
  }

  async detect(frame: Frame) {
    // The model takes the encoded image as an array of byte values.
    const raw = await (this.ai as unknown as LooseAi).run(DETR_MODEL, { image: Array.from(frame.bytes) });
    return parseObjectDetections(raw, frame.width, frame.height);
  }
}

export class WorkersAiMoondreamDetector implements VehicleDetector {
  readonly name = 'workers-ai/moondream3.1-detect';
  private readonly ai: Ai;
  private readonly target: string;
  constructor(ai: Ai, target = 'vehicle') {
    this.ai = ai;
    this.target = target;
  }

  async detect(frame: Frame) {
    const raw = (await (this.ai as unknown as LooseAi).run(MOONDREAM_MODEL, {
      task: 'detect',
      image: `data:image/jpeg;base64,${bytesToBase64(frame.bytes)}`,
      target: this.target,
      max_objects: 60,
    })) as { objects?: { x_min: number; y_min: number; x_max: number; y_max: number }[] };
    if (!raw || !Array.isArray(raw.objects)) throw new Error('Unexpected Moondream response shape');
    return parseObjectDetections(
      raw.objects.map((o) => ({ label: 'car', score: MOONDREAM_SCORE, box: { xmin: o.x_min, ymin: o.y_min, xmax: o.x_max, ymax: o.y_max } })),
      frame.width,
      frame.height,
    );
  }
}

/** Tries each detector in order; sticks with the first one that succeeds (per isolate). */
export class FallbackVehicleDetector implements VehicleDetector {
  private preferred = 0;
  private readonly chain: VehicleDetector[];
  constructor(chain: VehicleDetector[]) {
    this.chain = chain;
  }

  get name() {
    return this.chain[this.preferred]!.name;
  }

  async detect(frame: Frame) {
    const errors: string[] = [];
    for (let i = this.preferred; i < this.chain.length; i++) {
      try {
        const out = await this.chain[i]!.detect(frame);
        this.preferred = i;
        return out;
      } catch (e) {
        errors.push(`${this.chain[i]!.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`All vehicle detectors failed. ${errors.join(' | ')}`);
  }
}

export class FixtureVehicleDetector implements VehicleDetector {
  readonly name = 'fixture/recorded-detr';
  private readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async detect(frame: Frame) {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/${frame.hash}`);
    if (!res.ok) throw new Error(`No recorded detections for frame ${frame.hash.slice(0, 12)} (HTTP ${res.status})`);
    return parseObjectDetections(await res.json(), frame.width, frame.height);
  }
}

let shared: { ai: Ai; detector: VehicleDetector } | null = null;

/**
 * DETECTOR env var: "auto" (default: DETR, falling back to Moondream),
 * "detr", "moondream", or "fixture" (dev only).
 */
export function createVehicleDetector(env: Env): VehicleDetector | null {
  if (env.DETECTOR === 'fixture') return env.FIXTURE_DETECTIONS_URL ? new FixtureVehicleDetector(env.FIXTURE_DETECTIONS_URL) : null;
  if (!env.AI) return null;
  if (env.DETECTOR === 'detr') return new WorkersAiDetrDetector(env.AI);
  if (env.DETECTOR === 'moondream') return new WorkersAiMoondreamDetector(env.AI);
  // Reuse across requests in the same isolate so the fallback choice sticks.
  if (!shared || shared.ai !== env.AI) {
    shared = { ai: env.AI, detector: new FallbackVehicleDetector([new WorkersAiDetrDetector(env.AI), new WorkersAiMoondreamDetector(env.AI)]) };
  }
  return shared.detector;
}

export class CurbGapParkingDetector implements ParkingDetector {
  private readonly vehicles: VehicleDetector;
  constructor(vehicles: VehicleDetector) {
    this.vehicles = vehicles;
  }

  get name() {
    return `curb-gap+${this.vehicles.name}`;
  }

  async analyze(frame: Frame, ctx: AnalysisContext) {
    const timestamp = new Date().toISOString();
    const detected = cleanVehicles(await this.vehicles.detect(frame), MIN_VEHICLE_SCORE);
    const regions = ctx.calibration?.regions ?? [];
    const result = analyzeCurbGaps(detected, regions, {
      imageWidth: frame.width,
      imageHeight: frame.height,
      minVehicleScore: MIN_VEHICLE_SCORE,
      minConfidence: ctx.minConfidence,
      nowMs: Date.parse(frame.fetchedAt) || Date.now(),
      state: ctx.laneState,
      frameHash: frame.hash,
      // Evidence older than maxDetectionAgeSeconds decays to ~5% (e^-3), i.e. back to the prior.
      ...(ctx.maxDetectionAgeSeconds ? { tauSec: Math.min(DEFAULT_GAP_OPTIONS.tauSec, ctx.maxDetectionAgeSeconds / 3) } : {}),
    });

    const regionById = new Map(regions.map((r) => [r.id, r]));
    const candidates: ParkingCandidate[] = result.candidates.map((g) => {
      const anchor = regionById.get(g.regionId)?.anchor;
      return {
        cameraId: frame.cameraId,
        regionId: g.regionId,
        streetLabel: g.streetLabel,
        spaces: g.spaces,
        confidence: g.confidence,
        status: g.status,
        gapStart: g.start,
        gapEnd: g.end,
        lengthM: g.lengthM,
        polygon: g.polygon,
        lat: anchor?.lat ?? ctx.camera.lat,
        lon: anchor?.lon ?? ctx.camera.lon,
        approximateLocation: !anchor,
        reasons: g.reasons,
      };
    });

    const status = result.status;
    const confidence = result.confidence;

    return {
      cameraId: frame.cameraId,
      timestamp,
      frameFetchedAt: frame.fetchedAt,
      frameHash: frame.hash,
      // Read after detect(): a fallback detector may have switched models.
      detector: this.name,
      vehiclesDetected: result.vehicles,
      parkedVehicles: result.parkedVehicles,
      candidateSpaces: status === 'unknown' ? 0 : candidates.reduce((s, c) => s + c.spaces, 0),
      confidence,
      status,
      reason: result.reason,
      objects: result.objects,
      candidates: status === 'unknown' ? [] : candidates,
      notes: result.notes,
      error: null,
      laneState: result.state,
    };
  }
}
