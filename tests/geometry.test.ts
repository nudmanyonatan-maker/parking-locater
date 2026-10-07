import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  complementIntervals,
  homographyFrom4,
  homographyW,
  isConvexQuad,
  laneHomography,
  mergeIntervals,
  pointInPolygon,
  solveLinear,
  subtractIntervals,
} from '../shared/geometry';
import type { Point } from '../shared/types';

const close = (a: Point, b: Point, digits = 6) => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

describe('solveLinear', () => {
  it('solves a small system', () => {
    const x = solveLinear([[2, 1], [1, 3]], [3, 5])!;
    expect(x[0]).toBeCloseTo(0.8, 10);
    expect(x[1]).toBeCloseTo(1.4, 10);
  });
  it('returns null for singular systems', () => {
    expect(solveLinear([[1, 2], [2, 4]], [1, 2])).toBeNull();
  });
});

describe('homography', () => {
  // A perspective trapezoid like a curb lane receding from the camera.
  const quad: Point[] = [[0.128, 1], [0.307, 1], [0.432, 0.533], [0.386, 0.533]];

  it('maps the 4 source corners onto the destination corners', () => {
    const dst: Point[] = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const H = homographyFrom4(quad, dst)!;
    quad.forEach((p, i) => close(applyHomography(H, p), dst[i]!));
  });

  it('round-trips image -> lane -> image', () => {
    const h = laneHomography(quad)!;
    const p: Point = [0.25, 0.8];
    close(applyHomography(h.toImage, applyHomography(h.toLane, p)), p);
  });

  it('normalizes the sign so w > 0 inside the lane for either winding', () => {
    for (const q of [quad, [...quad].reverse()]) {
      const h = laneHomography(q)!;
      expect(h).not.toBeNull();
      expect(homographyW(h.toLane, [0.25, 0.8])).toBeGreaterThan(0);
    }
  });

  it('rejects degenerate and non-convex quads', () => {
    expect(laneHomography([[0, 0], [1, 0], [1, 1]])).toBeNull();
    expect(laneHomography([[0, 0], [1, 1], [1, 0], [0, 1]])).toBeNull(); // bow-tie
    expect(laneHomography([[0, 0], [0.5, 0], [1, 0], [0.5, 1]])).toBeNull(); // collinear
  });
});

describe('isConvexQuad / pointInPolygon', () => {
  it('detects convexity', () => {
    expect(isConvexQuad([[0, 0], [1, 0], [1, 1], [0, 1]])).toBe(true);
    expect(isConvexQuad([[0, 0], [1, 0], [0.4, 0.4], [0, 1]])).toBe(false);
  });
  it('tests containment', () => {
    const sq: Point[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(pointInPolygon([0.5, 0.5], sq)).toBe(true);
    expect(pointInPolygon([1.5, 0.5], sq)).toBe(false);
  });
});

describe('intervals', () => {
  it('merges overlapping intervals regardless of order', () => {
    expect(mergeIntervals([[0.5, 0.7], [0.1, 0.3], [0.25, 0.4]])).toEqual([[0.1, 0.4], [0.5, 0.7]]);
  });
  it('complements within bounds', () => {
    expect(complementIntervals([[0.1, 0.4], [0.5, 0.7]])).toEqual([[0, 0.1], [0.4, 0.5], [0.7, 1]]);
    expect(complementIntervals([])).toEqual([[0, 1]]);
    expect(complementIntervals([[-0.2, 1.3]])).toEqual([]);
  });
  it('subtracts cut intervals', () => {
    expect(subtractIntervals([[0, 1]], [[0.2, 0.3], [0.6, 0.8]])).toEqual([[0, 0.2], [0.3, 0.6], [0.8, 1]]);
    expect(subtractIntervals([[0.2, 0.4]], [[0, 1]])).toEqual([]);
  });
});
