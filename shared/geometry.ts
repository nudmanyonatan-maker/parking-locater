// Plane geometry for curb-lane analysis. Pure functions, no dependencies.

import type { Point } from './types';

/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/**
 * Solve A x = b (n x n) with Gaussian elimination and partial pivoting.
 * Returns null when the system is singular.
 */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Hartley normalization: centroid to the origin, mean distance sqrt(2). */
function normalizer(pts: Point[]): Mat3 {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const md = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length;
  const k = md > 0 ? Math.SQRT2 / md : 1;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

export function mul3(A: Mat3, B: Mat3): Mat3 {
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i * 3 + k]! * B[k * 3 + j]!;
      C[i * 3 + j] = s;
    }
  return C;
}

/**
 * Homography H mapping each src[i] to dst[i] for 4 correspondences (direct
 * linear transform with Hartley normalization, so pixel and normalized
 * coordinates are equally well conditioned). Returns null for degenerate quads.
 */
export function homographyFrom4(src: Point[], dst: Point[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const Ts = normalizer(src);
  const Td = normalizer(dst);
  const s = src.map((p) => applyHomography(Ts, p));
  const d = dst.map((p) => applyHomography(Td, p));
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = s[i]!;
    const [u, v] = d[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h || h.some((n) => !Number.isFinite(n))) return null;
  const TdInv = invert3(Td);
  if (!TdInv) return null;
  const H = mul3(mul3(TdInv, [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1]), Ts);
  const k = H[8] !== 0 ? H[8] : 1;
  return H.map((t) => t / k) as Mat3;
}

/** Jacobian of the mapping at image point p: [[du/dx, du/dy], [dv/dx, dv/dy]]. */
export function jacobian(H: Mat3, p: Point): [[number, number], [number, number]] {
  const w = homographyW(H, p);
  const [u, v] = applyHomography(H, p);
  return [
    [(H[0] - u * H[6]) / w, (H[1] - u * H[7]) / w],
    [(H[3] - v * H[6]) / w, (H[4] - v * H[7]) / w],
  ];
}

export function applyHomography(H: Mat3, [x, y]: Point): Point {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Projective denominator. For matrices from laneHomography, w <= 0 means beyond the horizon. */
export function homographyW(H: Mat3, [x, y]: Point): number {
  return H[6] * x + H[7] * y + H[8];
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv: Mat3 = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ];
  return inv.map((v) => v / det) as Mat3;
}

/** Unit-square corners matching the parking-lane point order
 *  [start-curb, start-traffic, end-traffic, end-curb] -> (u, v). */
export const LANE_UNIT_SQUARE: Point[] = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

/** Image -> lane (u along street, v across: 0 = curb, 1 = traffic side). */
export function laneHomography(quad: Point[]): { toLane: Mat3; toImage: Mat3 } | null {
  if (quad.length !== 4 || !isConvexQuad(quad)) return null;
  let toLane = homographyFrom4(quad, LANE_UNIT_SQUARE);
  if (!toLane) return null;
  // H is only defined up to scale. Fix the sign so w > 0 inside the quad; then
  // w <= 0 reliably means "beyond the horizon line" (see homographyW).
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  if (homographyW(toLane, [cx, cy]) < 0) toLane = toLane.map((v) => -v) as Mat3;
  let toImage = invert3(toLane);
  if (!toImage) return null;
  if (homographyW(toImage, [0.5, 0.5]) < 0) toImage = toImage.map((v) => -v) as Mat3;
  return { toLane, toImage };
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** True when the 4 points form a simple convex quadrilateral (either winding). */
export function isConvexQuad(q: Point[]): boolean {
  if (q.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i]!, q[(i + 1) % 4]!, q[(i + 2) % 4]!);
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon([x, y]: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
  }
  return Math.abs(a / 2);
}

export type Interval = [number, number];

/** Merge overlapping/adjacent intervals. Input need not be sorted. */
export function mergeIntervals(list: Interval[], epsilon = 0): Interval[] {
  const sorted = list
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as Interval)
    .sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + epsilon) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** Portions of [lo, hi] not covered by `covered` (which must be merged). */
export function complementIntervals(covered: Interval[], lo = 0, hi = 1): Interval[] {
  const out: Interval[] = [];
  let cursor = lo;
  for (const [a, b] of covered) {
    if (b <= lo || a >= hi) continue;
    if (a > cursor) out.push([cursor, Math.min(a, hi)]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < hi) out.push([cursor, hi]);
  return out;
}

/** Remove `cut` intervals from `base` intervals. */
export function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  let result = base.map((iv) => [...iv] as Interval);
  for (const [c0, c1] of mergeIntervals(cut)) {
    const next: Interval[] = [];
    for (const [a, b] of result) {
      if (c1 <= a || c0 >= b) {
        next.push([a, b]);
        continue;
      }
      if (c0 > a) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    result = next;
  }
  return result;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
