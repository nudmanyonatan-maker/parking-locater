import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAR } from '../shared/car';
import { analyzeCurbGaps, laneDiagnostics, type LaneStates } from '../shared/curb-gaps';
import type { DetectedObject, Point, Region } from '../shared/types';
import { CurbGapParkingDetector } from '../worker/analysis/detectors';
import { cleanVehicles, parseObjectDetections } from '../worker/analysis/vehicles';
import { acrossStreet, downTheCurb } from './helpers/scene';

const T0 = Date.parse('2026-10-07T12:00:00Z');

/** Run the analyzer over several frames, 20 s apart, carrying the lane state. */
function runFrames(frames: DetectedObject[][], regions: Region[], extra: Partial<Parameters<typeof analyzeCurbGaps>[2]> = {}) {
  let state: LaneStates | undefined = extra?.state;
  let last = analyzeCurbGaps([], regions, { nowMs: T0 });
  frames.forEach((objects, k) => {
    last = analyzeCurbGaps(objects, regions, { ...extra, nowMs: T0 + k * 20_000, state });
    state = last.state;
  });
  return last;
}

describe('curb-gap analysis on a synthetic street', () => {
  // Truth: 6-space lane (36.6 m); cars at 0.5, 6.0, 18.6, 24.4, 30.4 m => a 7.9 m opening at 10.7–18.6 m.
  const gapCars = (s: ReturnType<typeof acrossStreet>) => [0.5, 6.0, 18.6, 24.4, 30.4].map((m) => s.car(m));
  const fullCars = (s: ReturnType<typeof acrossStreet>) => [0.5, 6.6, 12.7, 18.8, 24.9, 31.0].map((m) => s.car(m));

  it('finds the opening where it really is, and grows more confident as it persists', () => {
    const s = acrossStreet();
    const one = runFrames([gapCars(s)], [s.lane]);
    const five = runFrames(Array(5).fill(gapCars(s)), [s.lane]);
    expect(five.status).toBe('possible');
    const gap = five.candidates[0]!;
    expect(gap.start * s.lengthM).toBeGreaterThan(9.5);
    expect(gap.start * s.lengthM).toBeLessThan(12);
    expect(gap.end * s.lengthM).toBeGreaterThan(17.5);
    expect(gap.end * s.lengthM).toBeLessThan(20);
    expect(gap.lengthM).toBeGreaterThan(6.5);
    expect(gap.lengthM).toBeLessThan(9.5);
    expect(gap.spaces).toBe(1);
    expect(gap.boundedBothSides).toBe(true);
    expect(gap.confidence).toBeGreaterThan(one.candidates[0]?.confidence ?? 0);
  });

  it('calls a long opening (two spaces) possible after one look and likely once it persists', () => {
    const s = acrossStreet();
    const cars = [0.5, 6.0, 24.4, 30.4].map((m) => s.car(m)); // 13.8 m open
    expect(runFrames([cars], [s.lane]).status).toBe('possible');
    const r = runFrames(Array(5).fill(cars), [s.lane]);
    expect(r.status).toBe('likely_available');
    expect(r.candidates[0]!.spaces).toBe(2);
  });

  it('reports a full curb as none', () => {
    const s = acrossStreet();
    const r = runFrames(Array(3).fill(fullCars(s)), [s.lane]);
    expect(r.status).toBe('none');
    expect(r.candidates).toHaveLength(0);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('never offers a space inside a RESTRICTED zone (hydrant, driveway, bus stop)', () => {
    const s = acrossStreet();
    const r = runFrames(Array(5).fill(gapCars(s)), [s.lane, s.zone('hydrant', 'restricted', 10, 19.5)]);
    expect(r.candidates).toHaveLength(0);
  });

  it('needs less room next to a physical end than between two cars', () => {
    const s = acrossStreet();
    const r = runFrames(Array(5).fill(gapCars(s)), [s.lane, s.zone('driveway', 'restricted', 10, 12.5)]);
    for (const c of r.candidates) expect(c.needM).toBe(CAR.needOneOpenEndM);
  });

  it('keeps 5 ft clear on both sides of a hydrant', () => {
    const s = acrossStreet();
    // Hydrant in the middle of the 7.9 m opening: what is left on either side is too short.
    const middle = runFrames(Array(5).fill(gapCars(s)), [{ ...s.lane, hydrantsM: [14.6] }]);
    expect(middle.candidates).toHaveLength(0);
    // Hydrant beside the car at 6.0-10.7 m: the opening starts 5 ft past it.
    const r = runFrames(Array(5).fill(gapCars(s)), [{ ...s.lane, hydrantsM: [9.5] }]);
    const gap = r.candidates[0]!;
    expect(gap.start * s.lengthM).toBeGreaterThanOrEqual(9.5 + 1.52 - 0.01);
    expect(gap.needM).toBe(CAR.needOneOpenEndM);
    expect(gap.reasons.join(' ')).toContain('hydrant');
  });

  it(`only offers openings long enough for a ${CAR.name}`, () => {
    const s = acrossStreet();
    // Cars at 0.5 and 6.0 m, then an opening of `m` metres starting at 10.7 m.
    const opening = (m: number) => [0.5, 6.0, 10.7 + m, 10.7 + m + 6].map((x) => s.car(x));
    const inOpening = (r: ReturnType<typeof runFrames>) => r.candidates.filter((c) => c.start * s.lengthM < 13);
    expect(inOpening(runFrames(Array(5).fill(opening(4.8)), [s.lane]))).toHaveLength(0);
    const fits = inOpening(runFrames(Array(5).fill(opening(7.0)), [s.lane]))[0]!;
    expect(fits.lengthM).toBeGreaterThan(CAR.needBetweenCarsM);
  });

  it('does not treat curb hidden behind a bus in the travel lane as free', () => {
    const s = acrossStreet();
    const bus: DetectedObject = { label: 'bus', score: 0.9, box: s.cuboidBox(8, 21, 3.2, 5.8, 3.2) };
    const r = runFrames(Array(5).fill([...gapCars(s), bus]), [s.lane]);
    expect(r.objects.find((o) => o.label === 'bus')?.role).toBe('roadway');
    expect(r.candidates.filter((c) => c.start * s.lengthM < 18 && c.end * s.lengthM > 11)).toHaveLength(0);
  });

  it('looking down the curb, a single frame is not enough (cars hide the curb behind them)', () => {
    const s = downTheCurb();
    expect(runFrames([gapCars(s)], [s.lane]).status).toBe('none');
    const later = runFrames(Array(6).fill(gapCars(s)), [s.lane]);
    expect(later.candidates.length).toBeGreaterThan(0);
  });

  it('marks vehicles in IGNORE regions as ignored', () => {
    const s = acrossStreet();
    const r = analyzeCurbGaps(gapCars(s), [s.lane, s.zone('ign', 'ignore', 0, 5.5)], { nowMs: T0 });
    expect(r.objects[0]!.role).toBe('ignored');
    expect(r.objects[1]!.role).toBe('parked');
  });

  it('splits one box that covers two bumper-to-bumper cars (side-ish view)', () => {
    const s = acrossStreet();
    const merged: DetectedObject = { label: 'car', score: 0.9, box: s.cuboidBox(18.6, 18.6 + 4.7 + 0.8 + 4.7, 0.3, 2.1, 1.5) };
    const r = analyzeCurbGaps([s.car(0.5), merged], [s.lane], { nowMs: T0 });
    const occupied = r.lanes[0]!.occupied.map(([a, b]) => [a * s.lengthM, b * s.lengthM]);
    const covering = occupied.find(([a]) => a! > 15 && a! < 22)!;
    expect(covering[1]! - covering[0]!).toBeGreaterThan(8);
  });

  it('says "unknown" instead of "empty street" when no cars are detected (night, glare)', () => {
    const s = acrossStreet();
    const r = runFrames([[], []], [s.lane]);
    expect(r).toMatchObject({ status: 'unknown', reason: 'no_vehicles_detected', candidates: [] });
  });

  it('forgets old evidence: a gap seen hours ago is not reported during a blind spell', () => {
    const s = acrossStreet();
    const seen = runFrames(Array(5).fill([0.5, 6.0, 24.4, 30.4].map((m) => s.car(m))), [s.lane]);
    expect(seen.candidates.length).toBeGreaterThan(0);
    const later = analyzeCurbGaps([], [s.lane], { nowMs: T0 + 3 * 3600_000, state: seen.state });
    expect(later.candidates).toHaveLength(0);
  });

  it('discards saved state when the lane is redrawn', () => {
    const s = acrossStreet();
    const seen = runFrames(Array(5).fill([0.5, 6.0, 24.4, 30.4].map((m) => s.car(m))), [s.lane]);
    const moved: Region = { ...s.lane, points: s.lane.points.map(([x, y]) => [x + 0.01, y] as [number, number]) };
    const r = analyzeCurbGaps(fullCars(s), [moved], { nowMs: T0 + 20_000, state: seen.state });
    expect(r.candidates).toHaveLength(0);
  });

  it('asks for calibration when no parking lane exists, and skips invalid quads', () => {
    const s = acrossStreet();
    expect(analyzeCurbGaps(gapCars(s), [], { nowMs: T0 })).toMatchObject({ status: 'unknown', reason: 'needs_calibration' });
    const bad: Region = { ...s.lane, id: 'bad', points: [[0, 0], [1, 1], [1, 0], [0, 1]] };
    const r = analyzeCurbGaps(gapCars(s), [bad], { nowMs: T0 });
    expect(r.reason).toBe('needs_calibration');
    expect(r.notes.join(' ')).toMatch(/not a valid 4-point quad/);
  });

  it('keeps a RESTRICTED zone drawn partly above the horizon (a tall box around a hydrant and its sign)', () => {
    const s = downTheCurb();
    const ground = s.zone('hydrant', 'restricted', 10, 19.5);
    const xs = ground.points.map((p) => p[0]);
    const curbY = Math.max(...ground.points.map((p) => p[1]));
    // From the curb up to near the top of the frame: the top corners lie beyond the horizon.
    const tall: Region = { id: 'hydrant', kind: 'restricted', points: [[Math.min(...xs), curbY], [Math.max(...xs), curbY], [Math.max(...xs), 0.05], [Math.min(...xs), 0.05]] };
    const cars = Array(5).fill(gapCars(s));
    expect(runFrames(cars, [s.lane]).candidates.length).toBeGreaterThan(0); // the opening is there without the zone
    const r = runFrames(cars, [s.lane, tall]);
    const blocked = r.lanes[0]!.blocked.map(([a, b]) => [a * s.lengthM, b * s.lengthM]);
    expect(blocked.some(([a, b]) => a! <= 10.5 && b! >= 19)).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it('keeps an IGNORE band that reaches the top of the frame (and never finds a gap on a full curb)', () => {
    const s = acrossStreet();
    const band: Region = { id: 'far', kind: 'ignore', points: [[0, 0], [1, 0], [1, 0.5], [0, 0.5]] };
    const r = runFrames(Array(10).fill(fullCars(s)), [s.lane, band]);
    expect(r.objects.filter((o) => o.role === 'ignored').length).toBeGreaterThan(0);
    expect(r.lanes[0]!.blocked.length).toBeGreaterThan(0);
    expect(r.lanes[0]!.blocked.at(-1)![1]).toBe(1);
    expect(r).toMatchObject({ status: 'none', candidates: [] });
  });

  it('vehicles in IGNORE zones still hide the curb behind them', () => {
    const s = acrossStreet();
    // Full curb, but a bus in the travel lane hides the cars between 11 and 31 m.
    const seen = [0.5, 6.6, 31.0].map((m) => s.car(m));
    const bus: DetectedObject = { label: 'bus', score: 0.9, box: s.cuboidBox(10, 30, 3.2, 5.8, 3.2) };
    const travelLane: Region = {
      id: 'travel',
      kind: 'ignore',
      points: ([[-5, 3], [45, 3], [45, 9], [-5, 9]] as const).map(([X, Y]) => s.project([X, Y, 0])) as Point[],
    };
    const r = runFrames(Array(5).fill([...seen, bus]), [s.lane, travelLane]);
    expect(r.objects.find((o) => o.label === 'bus')?.role).toBe('ignored');
    expect(r.candidates.filter((c) => c.start * s.lengthM < 30 && c.end * s.lengthM > 12)).toHaveLength(0);
  });

  it('does not report curb that is hidden right now from what it looked like minutes ago', () => {
    const s = acrossStreet();
    const open = [0.5, 6.0, 24.4, 30.4].map((m) => s.car(m)); // 13.8 m open
    const seen = runFrames(Array(5).fill(open), [s.lane]);
    expect(seen.status).toBe('likely_available');
    // Then a car parks in the opening while a bus in the travel lane hides that stretch.
    const bus: DetectedObject = { label: 'bus', score: 0.9, box: s.cuboidBox(9, 25, 3.2, 5.8, 3.2) };
    const t = T0 + 4 * 20_000;
    for (const minutes of [1, 2, 5, 8]) {
      const r = analyzeCurbGaps([...open, bus], [s.lane], { nowMs: t + minutes * 60_000, state: seen.state });
      expect(r.candidates.filter((c) => c.start * s.lengthM < 23 && c.end * s.lengthM > 11)).toHaveLength(0);
    }
    // Control: without the bus the opening is still reported.
    expect(analyzeCurbGaps(open, [s.lane], { nowMs: t + 60_000, state: seen.state }).candidates.length).toBeGreaterThan(0);
  });

  it('caps a gap that is only partly visible right now at "possible"', () => {
    const s = downTheCurb(); // parked cars hide about half of the opening behind them
    const r = runFrames(Array(6).fill(gapCars(s)), [s.lane]);
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.status).toBe('possible');
      expect(c.reasons).toContain('Partly hidden in the current camera image');
    }
  });

  it('does not fuse the same (frozen) camera image twice', () => {
    const s = acrossStreet();
    const cars = [0.5, 6.0, 24.4, 30.4].map((m) => s.car(m));
    const run = (hash: (k: number) => string) => {
      let state: LaneStates | undefined;
      return [0, 1, 2, 3].map((k) => {
        const r = analyzeCurbGaps(cars, [s.lane], { nowMs: T0 + k * 45_000, state, frameHash: hash(k) });
        state = r.state;
        return r;
      });
    };
    const frozen = run(() => 'same-bytes');
    expect(frozen.map((r) => r.status)).toEqual(['possible', 'possible', 'possible', 'possible']);
    for (const r of frozen.slice(1)) expect(r.confidence).toBeLessThanOrEqual(frozen[0]!.confidence);
    expect(frozen[1]!.notes).toContain('Same camera image as the last check; not counted again.');
    // New pictures are new evidence.
    expect(run((k) => `frame-${k}`).at(-1)!.status).toBe('likely_available');
  });

  it('reports lane geometry diagnostics for the calibration screen', () => {
    const d = laneDiagnostics(downTheCurb().lane)!;
    expect(d.lengthM).toBeCloseTo(36.6, 5);
    expect(d.pxPerMetreStart).toBeGreaterThan(d.pxPerMetreEnd); // nearer is bigger
    expect(d.calibrationSigmaM).toBeLessThan(2);
  });
});

describe('CurbGapParkingDetector', () => {
  it('forgets evidence older than maxDetectionAgeSeconds', async () => {
    const s = acrossStreet();
    const lengthBins = Math.ceil(s.lengthM / 0.25);
    const fetchedAt = '2026-10-07T12:05:00.000Z';
    // Five minutes ago every bin looked clearly free; this frame shows no vehicles at all (no update).
    const laneState: LaneStates = {};
    const seen = analyzeCurbGaps([], [s.lane], { nowMs: T0 });
    laneState[s.lane.id] = { ...seen.state[s.lane.id]!, t: Date.parse(fetchedAt) - 300_000, logodds: Array(lengthBins).fill(-4) };
    const detector = new CurbGapParkingDetector({ name: 'stub', detect: async () => [] });
    const frame = { cameraId: 'cam', bytes: new Uint8Array(), width: 352, height: 240, fetchedAt, hash: 'h1' };
    const ctx = { calibration: { cameraId: 'cam', regions: [s.lane], referenceWidth: 352, referenceHeight: 240, updatedAt: fetchedAt }, minConfidence: 0.6, camera: { lat: 0, lon: 0, name: 'cam' } };
    const prior = Math.log(0.75 / 0.25);
    const aged = await detector.analyze(frame, { ...ctx, laneState, maxDetectionAgeSeconds: 300 });
    // e^-3 of the old evidence is left: back near the 75%-occupied prior.
    expect(aged.laneState![s.lane.id]!.logodds[0]).toBeGreaterThan(prior - 0.3);
    // A longer max age keeps more of it.
    const kept = await detector.analyze(frame, { ...ctx, laneState, maxDetectionAgeSeconds: 1800 });
    expect(kept.laneState![s.lane.id]!.logodds[0]).toBeLessThan(-1);
  });
});

describe('real frames (Audubon Ave @ W 181 St, 2026-10-07 00:26 EDT)', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/audubon-181-night.json', 'utf8'));

  it('sees a packed curb at night: many parked cars, no openings', () => {
    let state: LaneStates | undefined;
    for (const [k, frame] of (fixture.frames as { detr: unknown[] }[]).entries()) {
      const vehicles = cleanVehicles(parseObjectDetections(frame.detr, 352, 240), 0.35);
      const r = analyzeCurbGaps(vehicles, fixture.calibration.regions, { nowMs: T0 + k * 4000, state });
      state = r.state;
      expect(r.parkedVehicles).toBeGreaterThanOrEqual(7);
      expect(r.status).toBe('none');
    }
  });
});
