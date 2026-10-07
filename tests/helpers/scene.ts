// Synthetic street scene for analyzer tests: a pinhole camera (f = 280 px,
// 352x240 image) looking at a curb lane, with cuboid cars. Ground truth is in
// metres: X along the curb (0..lengthM), Y across (0 = curb), Z up.

import type { DetectedObject, Point, Region } from '../../shared/types';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const W = 352;
export const H = 240;

export function makeScene(cameraAt: V3, lookAt: V3, capacity = 6, slotM = 6.1, laneWidthM = 2.4) {
  const z = norm(sub(lookAt, cameraAt));
  const x = norm(cross(z, [0, 0, 1]));
  const y = cross(z, x);
  const project = (P: V3): Point => {
    const d = sub(P, cameraAt);
    return [(176 + (280 * dot(d, x)) / dot(d, z)) / W, (120 + (280 * dot(d, y)) / dot(d, z)) / H];
  };
  const lengthM = capacity * slotM;
  const lane: Region = {
    id: 'lane',
    kind: 'parking',
    streetLabel: 'Test St',
    capacity,
    points: ([[0, 0], [0, laneWidthM], [lengthM, laneWidthM], [lengthM, 0]] as const).map(([X, Y]) => project([X, Y, 0])),
  };
  const cuboidBox = (x0: number, x1: number, y0: number, y1: number, h: number) => {
    const pts: Point[] = [];
    for (const X of [x0, x1]) for (const Y of [y0, y1]) for (const Z of [0, h]) pts.push(project([X, Y, Z]));
    return { xmin: Math.min(...pts.map((p) => p[0])), xmax: Math.max(...pts.map((p) => p[0])), ymin: Math.min(...pts.map((p) => p[1])), ymax: Math.max(...pts.map((p) => p[1])) };
  };
  /** A parked car starting `startM` metres along the curb. */
  const car = (startM: number, lenM = 4.7, score = 0.9): DetectedObject => ({ label: 'car', score, box: cuboidBox(startM, startM + lenM, 0.3, 2.1, 1.5) });
  /** A ground-level region spanning [x0, x1] metres along the lane, across the whole lane. */
  const zone = (id: string, kind: Region['kind'], x0: number, x1: number): Region => ({
    id,
    kind,
    points: ([[x0, -0.3], [x1, -0.3], [x1, laneWidthM + 0.3], [x0, laneWidthM + 0.3]] as const).map(([X, Y]) => project([X, Y, 0])),
  });
  return { lane, car, zone, cuboidBox, project, lengthM };
}

/** Camera across the street, looking obliquely at the curb (little self-occlusion). */
export const acrossStreet = () => makeScene([-14, 16, 7], [18, 1, 0]);
/** Camera on the same side, looking down the curb (cars hide the curb behind them). */
export const downTheCurb = () => makeScene([-12, -3, 8], [20, 1.2, 0]);
