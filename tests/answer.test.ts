import { describe, expect, it } from 'vitest';
import { CAR } from '../shared/car';
import { hydrantMarks, spotFacts } from '../shared/curb-gaps';
import type { ParkingCandidate, ParkingCurrentResponse, Region } from '../shared/types';
import { answerFor, lookCameras, shortCameraLabel } from '../src/lib/answer';

const lane: Region = {
  id: 'lane',
  kind: 'parking',
  capacity: 8, // 48.8 m
  streetLabel: 'W 181st St',
  points: [[0.128, 1], [0.307, 1], [0.432, 0.533], [0.386, 0.533]],
  hydrantsM: [5, 31.4],
};
const laneM = 8 * 6.1;

describe('spotFacts', () => {
  it('says whether the car fits between two cars', () => {
    expect(spotFacts({ gapStart: 10 / laneM, gapEnd: 16.5 / laneM }, lane)).toMatchObject({ openFt: 21, needFt: 19, fits: true, hydrantFt: null });
    expect(spotFacts({ gapStart: 10 / laneM, gapEnd: 15 / laneM }, lane).fits).toBe(false);
  });
  it('reports a nearby hydrant and needs less room next to its zone', () => {
    const f = spotFacts({ gapStart: 6.6 / laneM, gapEnd: 12 / laneM, lengthM: 5.4 }, lane);
    expect(f.hydrantFt).toBe(5);
    expect(f.needFt).toBe(Math.round(CAR.needOneOpenEndM * 3.28084));
    expect(f.fits).toBe(true);
  });
});

describe('hydrantMarks', () => {
  it('puts each hydrant on the curb line, nearer hydrants lower in the frame', () => {
    const [near, far] = hydrantMarks(lane);
    expect(near!.point[1]).toBeGreaterThan(far!.point[1]);
    expect(near!.zone).toHaveLength(4);
    expect(hydrantMarks({ ...lane, kind: 'restricted' })).toEqual([]);
  });
});

describe('answerFor', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const iso = new Date(now - 20_000).toISOString();
  const latest = (status: string, reason: string | null = null) => ({ id: 1, cameraId: 'cam', timestamp: iso, freshness: 'live', status, reason, candidates: [] });
  const data = (candidates: Partial<ParkingCandidate>[], status = 'likely_available', reason: string | null = null) =>
    ({
      generatedAt: iso,
      candidates: candidates.map((c) => ({ cameraId: 'cam', regionId: 'lane', streetLabel: 'W 181st St', spaces: 1, confidence: 0.8, status: 'likely_available', gapStart: 10 / laneM, gapEnd: 16.5 / laneM, lengthM: 6.5, ...c })),
      watched: [{ id: 'cam', name: 'Audubon', distanceMi: 0.2, preference: { streetLabel: 'W 181st St' }, latest: latest(status, reason) }],
    }) as unknown as ParkingCurrentResponse;
  const lanes = { cam: [lane] };

  it('says yes only for a likely spot the car fits in', () => {
    const a = answerFor(data([{}]), lanes, now);
    expect(a).toMatchObject({ tone: 'yes', title: 'Yes, 1 open spot', detail: 'W 181st St' });
    expect(a.spot?.facts.fits).toBe(true);
    expect(a.camera?.id).toBe('cam');
  });
  it('says maybe for a tight or uncertain spot', () => {
    expect(answerFor(data([{ lengthM: 4.8, gapEnd: 14.8 / laneM }]), lanes, now).tone).toBe('maybe');
    expect(answerFor(data([{ status: 'possible' }]), lanes, now).tone).toBe('maybe');
  });
  it('says no when the camera saw a full curb, and why it cannot tell otherwise', () => {
    expect(answerFor(data([], 'none'), lanes, now)).toMatchObject({ tone: 'no', title: 'No open spots' });
    expect(answerFor(data([], 'unknown', 'no_vehicles_detected'), lanes, now)).toMatchObject({ tone: 'unknown', detail: "Couldn't see any cars (dark or glare?)" });
  });
});

describe('lookCameras', () => {
  const cam = (id: string, name: string, distanceMi: number, extra = {}) =>
    ({ id, name, distanceMi, catalogOnline: true, preference: { streetLabel: null }, ...extra }) as never;
  const audubon = cam('a', 'Audobon Ave @ W 181 ST', 0.21, { preference: { streetLabel: 'W 181st St, Audubon → Amsterdam' } });
  const stNick = cam('s', 'St Nicholas Ave @ 181 St', 0.23);
  const amsterdam = cam('m', 'Amsterdam Ave @ 181 St', 0.209);
  const offline = cam('o', 'Somewhere @ 182 St', 0.1, { catalogOnline: false });
  const highway = cam('h', 'Amsterdam Ave @ W 180 st', 0.34);

  it('puts the parking camera first, then nearby street cameras, nearest first', () => {
    const list = lookCameras({ watched: [audubon], nearby: [amsterdam, audubon, stNick, offline, highway] });
    expect(list.map((c) => c.id)).toEqual(['a', 'm', 's']);
  });
  it('makes short tab labels', () => {
    expect(shortCameraLabel(audubon)).toBe('W 181st');
    expect(shortCameraLabel(stNick)).toBe('St Nicholas');
    expect(shortCameraLabel(amsterdam)).toBe('Amsterdam');
  });
});
