// Curb-gap analysis: given vehicle boxes and a calibrated parking lane, find
// car-sized openings along the curb.
//
// Model (validated on a synthetic pinhole street scene; see README "How it works"):
//  1. Each parking lane is a 4-point quad. A homography maps it to a unit
//     rectangle: u along the street, v across (0 = curb, 1 = traffic edge).
//     Lane length in metres = capacity x slotM (6.1 m, a typical NYC space).
//  2. Each vehicle's ground footprint is FITTED so its projected bounding box
//     matches the detection's xmin, xmax and ymax (ymin depends on the unknown
//     height). Merged boxes of 2-3 bumper-to-bumper cars are split. Footprints
//     inside the lane are parked; ones on the traffic side only occlude.
//  3. The lane is a 1-D occupancy grid (0.25 m bins, log-odds, prior 75%
//     occupied). A bin under a parked footprint gets "occupied" evidence. Any
//     other bin gets "free" evidence only in proportion to how visible a car
//     parked there would be: detector recall at that distance x the fraction
//     of a hypothetical car box not covered by other vehicles. Curb hidden
//     behind a parked car or a bus therefore stays unknown, never "free".
//     The grid is persisted between checks and decays toward the prior. A
//     frame identical to the one fused last time (frozen camera) adds no
//     evidence.
//  4. Runs of likely-free bins minus RESTRICTED/IGNORE zones are gaps. A gap's
//     confidence = P(long enough | measurement noise) x mean P(free) x a
//     far-field factor (pixels per metre along the curb). A gap is only
//     reported when enough of it is seen free in THIS frame, so curb that is
//     hidden right now is never reported from remembered evidence alone.
//
// It only says "the curb looks open". Hydrants are listed per lane (metres
// along it) and block HYDRANT_CLEARANCE_M on each side; driveways and signs
// are known only if marked RESTRICTED during calibration. "Long enough" means
// long enough for CAR (see car.ts).

import { CAR, feet, HYDRANT_CLEARANCE_M, M_TO_FT } from './car';
import {
  applyHomography,
  clamp,
  homographyW,
  jacobian,
  laneHomography,
  mergeIntervals,
  pointInPolygon,
  type Interval,
  type Mat3,
} from './geometry';
import type { DetectedObject, ParkingStatus, Point, Region } from './types';

export const VEHICLE_LABELS = ['car', 'truck', 'bus', 'motorcycle'] as const;

/** Assumed ground size by class (metres). */
const VEHICLE_SIZE: Record<string, { lenM: number; widM: number }> = {
  car: { lenM: 4.7, widM: 1.85 },
  truck: { lenM: 6.5, widM: 2.1 },
  bus: { lenM: 12, widM: 2.55 },
  motorcycle: { lenM: 2.2, widM: 0.8 },
};

export interface GapOptions {
  imageWidth: number;
  imageHeight: number;
  /** Ignore detections below this score. Low because evidence is fused over time. */
  minVehicleScore: number;
  /** Candidate confidence needed for "likely_available". */
  minConfidence: number;
  /** Candidates below this confidence are not reported at all. */
  reportConfidence: number;
  /** Length of one parking space (m). */
  slotM: number;
  /** Width of the parking lane quad (m), used for across-lane units. */
  widthM: number;
  binM: number;
  /** Prior probability that a curb bin is occupied (NYC curbs are usually full). */
  priorOcc: number;
  /** Evidence half-life-ish decay toward the prior between checks (s). */
  tauSec: number;
  /** Per-frame false-positive rate of the detector. */
  fp: number;
  /** Free length needed when the gap is bounded by cars / continues out of view. */
  needBothM: number;
  /** Free length needed when one end is a physical end (hydrant or restricted zone). */
  needOneM: number;
  /** Curb kept clear on each side of a hydrant (m). */
  hydrantClearanceM: number;
  /** Detector box-edge noise in pixels. */
  sigmaPx: number;
  /** Below this many pixels per metre along the curb, gaps are not reported. */
  minPxPerM: number;
  /** At or above this, no far-field penalty. */
  goodPxPerM: number;
  /** A bin counts as free when P(occupied) is below this. */
  pOccMax: number;
  /**
   * How much of a gap the current frame must show free (mean visible fraction
   * of a car parked there, 0 under detected cars) for it to be reported at all.
   */
  minSeenNow: number;
  /** Visible share needed for "likely_available"; below it the gap is at most "possible". */
  likelySeenNow: number;
  /** Current time (ms since epoch), for decaying persisted state. */
  nowMs: number;
  /** Persisted lane grids from the previous check, keyed by region id. */
  state?: LaneStates;
  /** Hash of the frame being analyzed. A frame already fused into a lane grid is not fused again. */
  frameHash?: string;
}

export const DEFAULT_GAP_OPTIONS: Omit<GapOptions, 'nowMs'> = {
  imageWidth: 352,
  imageHeight: 240,
  minVehicleScore: 0.3,
  minConfidence: 0.6,
  reportConfidence: 0.3,
  slotM: 6.1,
  widthM: 2.4,
  binM: 0.25,
  priorOcc: 0.75,
  tauSec: 600,
  fp: 0.03,
  needBothM: CAR.needBetweenCarsM,
  needOneM: CAR.needOneOpenEndM,
  hydrantClearanceM: HYDRANT_CLEARANCE_M,
  sigmaPx: 1.5,
  minPxPerM: 1.3,
  goodPxPerM: 3.0,
  pOccMax: 0.6,
  minSeenNow: 0.35,
  likelySeenNow: 0.6,
};

/** Persisted occupancy grid for one lane. */
export interface LaneState {
  /** ms since epoch of the last update */
  t: number;
  /** Calibration signature; state is discarded when the lane is redrawn. */
  sig: string;
  /** log-odds per bin, rounded to 2 decimals */
  logodds: number[];
  /** Hash of the last frame fused into this grid (a frozen camera repeats it). */
  frame?: string;
}
export type LaneStates = Record<string, LaneState>;

export interface GapResult {
  regionId: string;
  streetLabel: string;
  /** Lane-normalized extent (0..1). */
  start: number;
  end: number;
  lengthM: number;
  needM: number;
  slots: number;
  spaces: number;
  confidence: number;
  status: Exclude<ParkingStatus, 'none' | 'unknown'>;
  boundedBothSides: boolean;
  pLength: number;
  pFree: number;
  farFactor: number;
  /** How much of the gap the current frame shows free (0..1, see GapOptions.minSeenNow). */
  seenNow: number;
  /** Normalized image polygon of the gap. */
  polygon: Point[];
  reasons: string[];
}

export interface LaneResult {
  regionId: string;
  streetLabel: string;
  capacity: number;
  lengthM: number;
  parkedVehicles: number;
  /** Lane-normalized intervals covered by parked footprints. */
  occupied: Interval[];
  blocked: Interval[];
  gaps: GapResult[];
  /** Calibration sensitivity: metres of position error per pixel of corner error. */
  calibrationSigmaM: number;
  /** Pixels per metre along the curb at the near and far ends of the lane. */
  pxPerMetre: { start: number; end: number };
  /** Fraction of bins that were observed (visible) in this frame. */
  observedFraction: number;
  notes: string[];
}

export interface GapAnalysis {
  objects: DetectedObject[];
  vehicles: number;
  parkedVehicles: number;
  lanes: LaneResult[];
  candidates: GapResult[];
  status: ParkingStatus;
  confidence: number;
  reason: string | null;
  notes: string[];
  /** Updated lane grids to persist for the next check. */
  state: LaneStates;
}

type Box = DetectedObject['box'];

interface Lane {
  region: Region;
  toLane: Mat3;
  toImage: Mat3;
  capacity: number;
  lengthM: number;
  widthM: number;
  bins: number;
  sig: string;
  streetLabel: string;
  /** Smallest projective w treated as "on the ground" (tiny vs. w inside the lane quad). */
  wEps: number;
}

const isVehicle = (o: DetectedObject) => (VEHICLE_LABELS as readonly string[]).includes(o.label);
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (l: number) => 1 / (1 + Math.exp(-l));
/** Normal CDF approximation (|error| < 1e-3). */
const phi = (z: number) => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3)));
/**
 * Detector recall vs apparent car length in pixels: ~50% at 10 px, ~90% at
 * 17 px. On real 352x240 night frames DETR found 9-10 px cars with scores
 * above 0.9, so this is a moderate guess. Fit it on labelled frames.
 */
export const recallAt = (pxPerM: number) => 1 / (1 + Math.exp(-(pxPerM * 4.7 - 10) / 3));

const toPx = (p: Point, o: GapOptions): Point => [p[0] * o.imageWidth, p[1] * o.imageHeight];
const toNorm = (p: Point, o: GapOptions): Point => [clamp(p[0] / o.imageWidth, 0, 1), clamp(p[1] / o.imageHeight, 0, 1)];
const boxPx = (b: Box, o: GapOptions): Box => ({ xmin: b.xmin * o.imageWidth, xmax: b.xmax * o.imageWidth, ymin: b.ymin * o.imageHeight, ymax: b.ymax * o.imageHeight });

function laneSignature(region: Region, capacity: number, bins: number): string {
  return `${region.points.map((p) => p.map((v) => v.toFixed(4)).join(',')).join(';')}|${capacity}|${bins}`;
}

function buildLane(region: Region, o: GapOptions): Lane | null {
  const quadPx = region.points.map((p) => toPx(p, o));
  const h = laneHomography(quadPx);
  if (!h) return null;
  const capacity = Math.max(1, Math.round(region.capacity ?? 6));
  const lengthM = capacity * o.slotM;
  const bins = Math.max(4, Math.ceil(lengthM / o.binM));
  return {
    region,
    ...h,
    capacity,
    lengthM,
    widthM: o.widthM,
    bins,
    sig: laneSignature(region, capacity, bins),
    streetLabel: region.streetLabel || region.label || 'Curb lane',
    wEps: 1e-6 * Math.max(...quadPx.map((p) => Math.abs(homographyW(h.toLane, p)))),
  };
}

/** Pixels per metre along the curb at lane position u (centre line). */
export function pxPerMetre(lane: Pick<Lane, 'toImage' | 'lengthM'>, u: number): number {
  const du = 0.5 / lane.lengthM;
  const a = applyHomography(lane.toImage, [u - du, 0.5]);
  const b = applyHomography(lane.toImage, [u + du, 0.5]);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 1-sigma position error (m along the curb) at lane position u from sigmaPx of image noise. */
function sigmaMetres(lane: Lane, u: number, sigmaPx: number): number {
  const p = applyHomography(lane.toImage, [u, 0.5]);
  const J = jacobian(lane.toLane, p);
  return sigmaPx * Math.hypot(J[0][0], J[0][1]) * lane.lengthM;
}

/** Max shift (m) of lane positions when any quad corner moves by 1 px. */
function calibrationSigma(quadPx: Point[], lengthM: number): number {
  const base = laneHomography(quadPx);
  if (!base) return Infinity;
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const q = quadPx.map((p, j) => (j === i ? ([p[0] + dx, p[1] + dy] as Point) : p));
      const f = laneHomography(q);
      if (!f) return Infinity;
      for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const img = applyHomography(base.toImage, [u, 0.5]);
        worst = Math.max(worst, Math.abs(applyHomography(f.toLane, img)[0] - u) * lengthM);
      }
    }
  }
  return worst;
}

/** Image row of the ground-plane horizon at column x (where toLane's w = 0). */
function horizonY(lane: Lane, x: number): number {
  const H = lane.toLane;
  return Math.abs(H[7]) > 1e-12 ? -(H[6] * x + H[8]) / H[7] : -1e9;
}

interface Footprint {
  u0: number;
  u1: number;
  v0: number;
  vC: number;
  n: number;
}

/** Image-space mismatch between a ground rectangle and a detection box (px^2). */
function footprintCost(H: Mat3, b: Box, u0: number, lu: number, v0: number, wv: number): number {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < 4; k++) {
    const u = k === 1 || k === 2 ? u0 + lu : u0;
    const v = k >= 2 ? v0 + wv : v0;
    const w = H[6] * u + H[7] * v + H[8];
    const x = (H[0] * u + H[1] * v + H[2]) / w;
    const y = (H[3] * u + H[4] * v + H[5]) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return (x0 - b.xmin) ** 2 + (x1 - b.xmax) ** 2 + 2 * (y1 - b.ymax) ** 2;
}

/**
 * Fit the ground footprint of 1..maxN vehicles (bumper gap 0.9 m) to a box
 * using xmin, xmax and ymax. Coarse-to-fine search over u0 and v0.
 */
function fitFootprint(lane: Lane, b: Box, lenM: number, widM: number, maxN: number): Footprint | null {
  const bc: Point = [(b.xmin + b.xmax) / 2, b.ymax];
  if (homographyW(lane.toLane, bc) <= 0) return null;
  const uBc = clamp(applyHomography(lane.toLane, bc)[0], -0.5, 1.5);
  const wv = Math.min(0.95, widM / lane.widthM);

  /** Best u0 for a footprint of length lu at lateral offset v0. */
  const bestU = (lu: number, v0: number) => {
    const coarse = Math.max(0.002, lu / 12);
    let bu = uBc;
    let cost = Infinity;
    for (let u0 = uBc - 1.6 * lu; u0 <= uBc + 0.6 * lu; u0 += coarse) {
      const c = footprintCost(lane.toImage, b, u0, lu, v0, wv);
      if (c < cost) {
        cost = c;
        bu = u0;
      }
    }
    const from = bu - coarse; // bounds fixed up front: bu changes inside the loop
    const to = bu + coarse;
    for (let u0 = from; u0 <= to; u0 += coarse / 5) {
      const c = footprintCost(lane.toImage, b, u0, lu, v0, wv);
      if (c < cost) {
        cost = c;
        bu = u0;
      }
    }
    return { u0: bu, cost };
  };

  // One vehicle: search across the parking lane AND the next ~2 lane widths, so
  // vehicles in the travel lane are placed there (traffic), not forced to the curb.
  const lu1 = lenM / lane.lengthM;
  let best = { u0: uBc, v0: 0, cost: Infinity };
  for (let v0 = -0.3; v0 <= 2.5 + 1e-9; v0 += 0.2) {
    const r = bestU(lu1, v0);
    if (r.cost < best.cost) best = { u0: r.u0, v0, cost: r.cost };
  }
  const vFrom = best.v0 - 0.15;
  const vTo = best.v0 + 0.15;
  for (let v0 = vFrom; v0 <= vTo + 1e-9; v0 += 0.05) {
    const r = bestU(lu1, v0);
    if (r.cost < best.cost) best = { u0: r.u0, v0, cost: r.cost };
  }
  let fit: Footprint = { u0: best.u0, u1: best.u0 + lu1, v0: best.v0, vC: best.v0 + wv / 2, n: 1 };

  // Several bumper-to-bumper vehicles merged into one box: same lateral position.
  // Split only when that explains the box clearly better (end-on views make the
  // count nearly unidentifiable).
  for (let n = 2; n <= maxN; n++) {
    const lu = (n * lenM + (n - 1) * 0.9) / lane.lengthM;
    const r = bestU(lu, best.v0);
    if (r.cost < 0.5 * best.cost && r.cost + 4 * (n - 1) < best.cost) {
      fit = { u0: r.u0, u1: r.u0 + lu, v0: best.v0, vC: best.v0 + wv / 2, n };
      best = { ...best, cost: r.cost + 4 * (n - 1) };
    }
  }
  return fit;
}

/** Sutherland-Hodgman: the part of `poly` where f >= 0 (f must be affine in the polygon's coordinates). */
function clipPolygon(poly: Point[], f: (p: Point) => number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/**
 * u-range a region covers inside the lane band (v in [-0.2, 1.2]): null when
 * it misses the band, 'unmappable' when it cannot be placed on the ground.
 * Zones are free-drawn, so parts above the horizon (a tall box around a sign,
 * an IGNORE band up to the top of the frame) are cut off at the horizon
 * instead of discarding the whole zone. Points just below the horizon map very
 * far along the lane, which only makes the zone block more (the safe side).
 */
function regionInterval(lane: Lane, polyPx: Point[]): Interval | 'unmappable' | null {
  const ground = clipPolygon(polyPx, (p) => homographyW(lane.toLane, p) - lane.wEps);
  if (ground.length < 3) return null;
  const uv = ground.map((p) => applyHomography(lane.toLane, p));
  if (uv.some(([u, v]) => !Number.isFinite(u) || !Number.isFinite(v))) return 'unmappable';
  const band = clipPolygon(
    clipPolygon(uv, (p) => p[1] + 0.2),
    (p) => 1.2 - p[1],
  );
  if (band.length < 3) return null;
  const us = band.map((p) => p[0]);
  if (Math.max(...us) < 0 || Math.min(...us) > 1) return null;
  return [clamp(Math.min(...us), 0, 1), clamp(Math.max(...us), 0, 1)];
}

/** Image box of a hypothetical parked car centred at lane position u. */
function hypotheticalBox(lane: Lane, u: number, kH: number): Box {
  const lu = 4.7 / lane.lengthM;
  const wv = Math.min(0.95, 1.85 / lane.widthM);
  const v0 = 0.08;
  const c = (
    [
      [u - lu / 2, v0],
      [u + lu / 2, v0],
      [u + lu / 2, v0 + wv],
      [u - lu / 2, v0 + wv],
    ] as Point[]
  ).map((q) => applyHomography(lane.toImage, q));
  const ymax = Math.max(...c.map((q) => q[1]));
  const xmin = Math.min(...c.map((q) => q[0]));
  const xmax = Math.max(...c.map((q) => q[0]));
  return { xmin, xmax, ymax, ymin: ymax - kH * (ymax - horizonY(lane, (xmin + xmax) / 2)) };
}

/** Fraction of a box (5x5 samples) not covered by any of `boxes`. */
function visibleFraction(b: Box, boxes: Box[]): number {
  let seen = 0;
  for (let a = 0; a < 5; a++) {
    for (let c = 0; c < 5; c++) {
      const x = b.xmin + ((a + 0.5) / 5) * (b.xmax - b.xmin);
      const y = b.ymin + ((c + 0.5) / 5) * (b.ymax - b.ymin);
      if (!boxes.some((o) => x >= o.xmin && x <= o.xmax && y >= o.ymin && y <= o.ymax)) seen++;
    }
  }
  return seen / 25;
}

interface Placed {
  obj: DetectedObject;
  px: Box;
  lane: Lane | null;
  fp: Footprint | null;
}

/**
 * Analyze one frame. `objects` must use normalized coordinates (0..1).
 * Pass `state` from the previous check to fuse evidence over time.
 */
export function analyzeCurbGaps(objects: DetectedObject[], regions: Region[], options: Partial<GapOptions> = {}): GapAnalysis {
  const o: GapOptions = { ...DEFAULT_GAP_OPTIONS, nowMs: Date.now(), ...options };
  const notes: string[] = [];
  const lanes: Lane[] = [];
  for (const region of regions) {
    if (region.kind !== 'parking') continue;
    const lane = buildLane(region, o);
    if (lane) lanes.push(lane);
    else notes.push(`Lane "${region.label ?? region.id}" is not a valid 4-point quad; skipped.`);
  }
  const ignorePx = regions.filter((r) => r.kind === 'ignore').map((r) => r.points.map((p) => toPx(p, o)));
  const blockingPx = regions
    .filter((r) => r.kind === 'restricted' || r.kind === 'ignore')
    .map((r) => ({ name: r.label ?? r.id, poly: r.points.map((p) => toPx(p, o)) }));

  // 1. Place vehicles: ignored, parked in a lane, in the roadway, or outside.
  const vehicles = objects.filter((v) => isVehicle(v) && v.score >= o.minVehicleScore);
  const placed: Placed[] = vehicles.map((obj) => {
    const px = boxPx(obj.box, o);
    const ground: Point = [(px.xmin + px.xmax) / 2, px.ymax];
    if (ignorePx.some((poly) => pointInPolygon(ground, poly))) return { obj: { ...obj, role: 'ignored' }, px, lane: null, fp: null };
    const size = VEHICLE_SIZE[obj.label] ?? VEHICLE_SIZE.car!;
    let roadway = false;
    let best: { lane: Lane; fp: Footprint } | null = null;
    for (const lane of lanes) {
      const fp = fitFootprint(lane, px, size.lenM, size.widM, obj.label === 'car' ? 3 : 1);
      if (!fp || fp.u1 < -0.02 || fp.u0 > 1.02) continue;
      if (fp.vC <= 0.95) {
        if (!best || Math.abs(fp.vC - 0.5) < Math.abs(best.fp.vC - 0.5)) best = { lane, fp };
      } else {
        roadway = true; // double-parked or traffic: occludes the curb only
      }
    }
    if (best) return { obj: { ...obj, role: 'parked' }, px, lane: best.lane, fp: best.fp };
    return { obj: { ...obj, role: roadway ? 'roadway' : 'outside' }, px, lane: null, fp: null };
  });

  if (lanes.length === 0) {
    return {
      objects: placed.map((p) => p.obj),
      vehicles: vehicles.length,
      parkedVehicles: 0,
      lanes: [],
      candidates: [],
      status: 'unknown',
      confidence: 0,
      reason: 'needs_calibration',
      notes: [...notes, 'No parking lane is calibrated for this camera.'],
      state: {},
    };
  }

  // Every detected box hides what is behind it, including vehicles in IGNORE
  // zones: IGNORE only stops them from counting as parked.
  const occluders = placed.map((p) => p.px);
  const state: LaneStates = {};
  const laneResults: LaneResult[] = [];

  for (const lane of lanes) {
    const laneNotes: string[] = [];
    const parked = placed.filter((p) => p.lane === lane && p.fp);
    const quadPx = lane.region.points.map((p) => toPx(p, o));
    const calSigmaM = calibrationSigma(quadPx, lane.lengthM);
    const qCal = calSigmaM <= 1 ? 1 : calSigmaM <= 2 ? 0.8 : 0;
    if (qCal === 0) laneNotes.push('Lane is drawn too thin to measure reliably; redraw it wider (include the travel lane edge).');
    else if (qCal < 1) laneNotes.push(`Lane drawing is sensitive (${calSigmaM.toFixed(1)} m per pixel); measurements are less precise.`);

    // 2. Restore the grid and decay it toward the prior.
    const prior = logit(o.priorOcc);
    const prev = o.state?.[lane.region.id];
    const grid = new Float64Array(lane.bins).fill(prior);
    const restored = !!prev && prev.sig === lane.sig && prev.logodds.length === lane.bins;
    if (restored) {
      const k = Math.exp(-Math.max(0, o.nowMs - prev.t) / 1000 / o.tauSec);
      for (let i = 0; i < lane.bins; i++) grid[i] = prior + (prev.logodds[i]! - prior) * k;
    }
    // A frozen camera serves identical bytes: the same picture is no new evidence.
    const sameFrame = restored && !!o.frameHash && prev.frame === o.frameHash;
    if (sameFrame) laneNotes.push('Same camera image as the last check; not counted again.');

    // 3. Update with this frame. With no parked cars detected at all in a lane
    // that should hold several, assume a detector failure (night, glare): no update.
    const detectorBlind = parked.length === 0 && lane.capacity >= 3;
    if (detectorBlind) laneNotes.push('No parked vehicles detected in this lane; likely a detection failure (night, glare, occlusion).');

    const ks = parked
      .map((p) => {
        const d = p.px.ymax - horizonY(lane, (p.px.xmin + p.px.xmax) / 2);
        return d > 2 ? (p.px.ymax - p.px.ymin) / d : NaN;
      })
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const kH = ks[Math.floor(ks.length / 2)] ?? 0.3;
    let observed = 0;
    /** Per bin: how visible a car parked there would be in THIS frame (0 under a detected parked car). */
    const visibleNow = new Float64Array(lane.bins);
    if (!detectorBlind) {
      for (let i = 0; i < lane.bins; i++) {
        const u = (i + 0.5) / lane.bins;
        const recall = recallAt(pxPerMetre(lane, u));
        const hit = parked.find((p) => u >= p.fp!.u0 && u <= p.fp!.u1);
        let llr: number;
        if (hit) {
          llr = Math.log((recall * hit.obj.score + 1e-3) / o.fp);
          observed++;
        } else {
          const fVis = visibleFraction(hypotheticalBox(lane, u, kH), occluders);
          if (fVis >= 0.67) observed++;
          visibleNow[i] = fVis;
          const rEff = recall * fVis;
          llr = Math.log((1 - rEff) / (1 - o.fp));
        }
        if (!sameFrame) grid[i] = clamp(grid[i]! + llr, -4, 4);
      }
    }
    state[lane.region.id] = {
      t: o.nowMs,
      sig: lane.sig,
      logodds: Array.from(grid, (l) => Math.round(l * 100) / 100),
      ...(o.frameHash ? { frame: o.frameHash } : {}),
    };

    // 4. Gaps: runs of likely-free bins not blocked by RESTRICTED/IGNORE zones.
    const zoneIntervals: Interval[] = [];
    for (const zone of blockingPx) {
      const iv = regionInterval(lane, zone.poly);
      if (iv === 'unmappable') {
        // Never drop a zone silently: block the whole lane instead.
        laneNotes.push(`Zone "${zone.name}" could not be placed on this lane; the whole lane is treated as blocked.`);
        zoneIntervals.push([0, 1]);
      } else if (iv) zoneIntervals.push(iv);
    }
    // Padded by half a bin: bins are blocked by their midpoint, so a gap never starts inside the clearance.
    const pad = o.hydrantClearanceM + lane.lengthM / lane.bins / 2;
    const hydrants = (lane.region.hydrantsM ?? []).map((m): Interval => [(m - pad) / lane.lengthM, (m + pad) / lane.lengthM]);
    const blocked = mergeIntervals([...zoneIntervals, ...hydrants]);
    const isBlocked = (u: number) => blocked.some(([a, b]) => u >= a && u <= b);
    const pOcc = Array.from(grid, sigmoid);
    const gaps: GapResult[] = [];
    let i = 0;
    while (i < lane.bins) {
      const uMid = (i + 0.5) / lane.bins;
      if (pOcc[i]! >= o.pOccMax || isBlocked(uMid)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < lane.bins && pOcc[j + 1]! < o.pOccMax && !isBlocked((j + 1.5) / lane.bins)) j++;
      const a = i / lane.bins;
      const b = (j + 1) / lane.bins;
      let seen = 0;
      for (let k = i; k <= j; k++) seen += visibleNow[k]!;
      const seenNow = seen / (j - i + 1);
      i = j + 1;
      // Remembered evidence alone never makes a current candidate.
      if (seenNow < o.minSeenNow) continue;
      const lengthM = (b - a) * lane.lengthM;
      const startPhysical = a > 0 && isBlocked(a - 0.5 / lane.bins);
      const endPhysical = b < 1 && isBlocked(b + 0.5 / lane.bins);
      const atEdge = a <= 0 || b >= 1;
      const needM = startPhysical || endPhysical ? o.needOneM : o.needBothM;
      if (lengthM < 0.7 * needM) continue;

      const sEnd = (u: number) => Math.hypot(sigmaMetres(lane, u, o.sigmaPx), 0.35, Number.isFinite(calSigmaM) ? calSigmaM : 2);
      const sigma = Math.hypot(sEnd(a), sEnd(b));
      const pLength = phi((lengthM - needM) / sigma);
      const pFree = pOcc.slice(Math.round(a * lane.bins), Math.round(b * lane.bins)).reduce((s, p) => s + (1 - p), 0) / Math.max(1, j - Math.round(a * lane.bins) + 1);
      const ppm = pxPerMetre(lane, (a + b) / 2);
      const farFactor = clamp((ppm - o.minPxPerM) / (o.goodPxPerM - o.minPxPerM), 0, 1);
      if (farFactor <= 0) continue;
      const confidence = pLength * pFree * (0.4 + 0.6 * farFactor) * qCal;
      if (confidence < o.reportConfidence) continue;

      const reasons: string[] = [];
      const boundedBothSides = !atEdge && !startPhysical && !endPhysical;
      const nearHydrant = hydrants.some(([h0, h1]) => (a - 0.5 / lane.bins >= h0 && a - 0.5 / lane.bins <= h1) || (b + 0.5 / lane.bins >= h0 && b + 0.5 / lane.bins <= h1));
      if (boundedBothSides) reasons.push('Opening between two parked vehicles');
      else if (atEdge) reasons.push('Opening runs to the edge of the visible lane; it may be longer');
      else if (nearHydrant) reasons.push(`Opening next to a hydrant (keeps ${feet(o.hydrantClearanceM)} ft away)`);
      else reasons.push('Opening next to a no-parking zone');
      reasons.push(`About ${feet(lengthM)} ft of open curb (your ${CAR.name} needs ~${feet(needM)} ft)`);
      if (farFactor < 1) reasons.push('Far from the camera; less precise');
      if (pFree < 0.75) reasons.push('Partly hidden or seen only briefly');
      const partlyHiddenNow = seenNow < o.likelySeenNow;
      if (partlyHiddenNow) reasons.push('Partly hidden in the current camera image');

      const polygon = ([[a, 0], [a, 1], [b, 1], [b, 0]] as Point[]).map((q) => toNorm(applyHomography(lane.toImage, q), o));
      const status = confidence >= o.minConfidence && pLength >= 0.5 && !partlyHiddenNow ? 'likely_available' : 'possible';
      gaps.push({
        regionId: lane.region.id,
        streetLabel: lane.streetLabel,
        start: a,
        end: b,
        lengthM: Number(lengthM.toFixed(1)),
        needM,
        slots: Number((lengthM / o.slotM).toFixed(2)),
        spaces: Math.max(1, Math.floor(lengthM / needM + 0.05)),
        confidence: Number(clamp(confidence, 0, 0.95).toFixed(3)),
        status,
        boundedBothSides,
        pLength: Number(pLength.toFixed(3)),
        pFree: Number(pFree.toFixed(3)),
        farFactor: Number(farFactor.toFixed(3)),
        seenNow: Number(seenNow.toFixed(2)),
        polygon,
        reasons,
      });
    }

    laneResults.push({
      regionId: lane.region.id,
      streetLabel: lane.streetLabel,
      capacity: lane.capacity,
      lengthM: lane.lengthM,
      parkedVehicles: parked.length,
      occupied: mergeIntervals(parked.map((p) => [clamp(p.fp!.u0, 0, 1), clamp(p.fp!.u1, 0, 1)] as Interval)),
      blocked,
      gaps: detectorBlind ? [] : gaps,
      calibrationSigmaM: Number(Math.min(calSigmaM, 99).toFixed(2)),
      pxPerMetre: { start: Number(pxPerMetre(lane, 0.02).toFixed(2)), end: Number(pxPerMetre(lane, 0.98).toFixed(2)) },
      observedFraction: Number((observed / lane.bins).toFixed(2)),
      notes: laneNotes,
    });
  }

  const candidates = laneResults.flatMap((l) => l.gaps).sort((p, q) => q.confidence - p.confidence);
  const parkedVehicles = laneResults.reduce((s, l) => s + l.parkedVehicles, 0);
  const allBlind = laneResults.every((l) => l.parkedVehicles === 0 && l.capacity >= 3);

  let status: ParkingStatus;
  let confidence: number;
  let reason: string | null = null;
  if (allBlind) {
    status = 'unknown';
    confidence = 0.2;
    reason = 'no_vehicles_detected';
  } else if (candidates.length) {
    status = candidates.some((c) => c.status === 'likely_available') ? 'likely_available' : 'possible';
    confidence = candidates[0]!.confidence;
  } else {
    status = 'none';
    // More of the curb actually seen => more sure it is full.
    const observedFraction = laneResults.reduce((s, l) => s + l.observedFraction, 0) / laneResults.length;
    confidence = clamp(0.5 + 0.45 * observedFraction, 0.5, 0.95);
  }

  return {
    objects: placed.map((p) => p.obj),
    vehicles: vehicles.length,
    parkedVehicles,
    lanes: laneResults,
    candidates,
    status,
    confidence: Number(confidence.toFixed(3)),
    reason,
    notes: [...notes, ...laneResults.flatMap((l) => l.notes)],
    state,
  };
}

/** Geometry diagnostics for the calibration screen. */
export function laneDiagnostics(region: Region, imageWidth = 352, imageHeight = 240) {
  const o = { ...DEFAULT_GAP_OPTIONS, imageWidth, imageHeight, nowMs: 0 };
  const lane = buildLane(region, o);
  if (!lane) return null;
  return {
    lengthM: lane.lengthM,
    pxPerMetreStart: pxPerMetre(lane, 0.02),
    pxPerMetreEnd: pxPerMetre(lane, 0.98),
    calibrationSigmaM: calibrationSigma(region.points.map((p) => toPx(p, o)), lane.lengthM),
  };
}

/** Where each hydrant on a parking lane is in the image (normalized): its curb point and its no-parking zone. */
export function hydrantMarks(region: Region, clearanceM = HYDRANT_CLEARANCE_M): { point: Point; zone: Point[] }[] {
  const o = { ...DEFAULT_GAP_OPTIONS, nowMs: 0 };
  const lane = region.kind === 'parking' ? buildLane(region, o) : null;
  if (!lane) return [];
  const img = (u: number, v: number) => toNorm(applyHomography(lane.toImage, [u, v]), o);
  return (region.hydrantsM ?? []).map((m) => {
    const a = (m - clearanceM) / lane.lengthM;
    const b = (m + clearanceM) / lane.lengthM;
    return { point: img(m / lane.lengthM, 0), zone: [img(a, 0), img(a, 1), img(b, 1), img(b, 0)] };
  });
}

export interface SpotFacts {
  /** Open curb, in feet. */
  openFt: number;
  /** What the car needs here, in feet. */
  needFt: number;
  fits: boolean;
  /** Distance from the spot to the nearest hydrant in feet, when one is within 15 ft; else null. */
  hydrantFt: number | null;
}

/** Plain-language facts about a reported opening: does the car fit, and how close is a hydrant. */
export function spotFacts(gap: { gapStart: number; gapEnd: number; lengthM?: number }, lane?: Region): SpotFacts {
  const laneM = Math.max(1, Math.round(lane?.capacity ?? 6)) * DEFAULT_GAP_OPTIONS.slotM;
  const startM = gap.gapStart * laneM;
  const endM = gap.gapEnd * laneM;
  const openM = gap.lengthM ?? endM - startM;
  const distances = (lane?.hydrantsM ?? []).map((h) => (h < startM ? startM - h : h > endM ? h - endM : 0));
  const nearestM = distances.length ? Math.min(...distances) : Infinity;
  // Same rule as the analyzer: a hydrant zone at one end leaves room to swing in.
  const needM = nearestM <= HYDRANT_CLEARANCE_M + DEFAULT_GAP_OPTIONS.binM * 2 ? CAR.needOneOpenEndM : CAR.needBetweenCarsM;
  return {
    openFt: feet(openM),
    needFt: feet(needM),
    fits: openM >= needM,
    hydrantFt: nearestM <= 15 / M_TO_FT ? feet(nearestM) : null,
  };
}
