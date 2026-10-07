import { describe, expect, it } from 'vitest';
import { bearingDegrees, formatMiles, haversineMiles, isValidLatLon, withinRadius } from '../shared/geo';
import { FALLBACK_HOME } from '../shared/settings';

// Real cameras from the 2026-10-07 TMC catalog.
const cams = [
  { id: 'audubon-181', lat: 40.84874, lon: -73.93235 },
  { id: 'amsterdam-181', lat: 40.84833, lon: -73.93087 },
  { id: 'amsterdam-178', lat: 40.84614, lon: -73.93243 },
  { id: 'cross-bronx', lat: 40.84154, lon: -73.92861 },
  { id: 'broken', lat: Number.NaN, lon: -73.9 },
];

describe('haversineMiles', () => {
  it('matches the discovery run distances', () => {
    expect(haversineMiles(FALLBACK_HOME, cams[0]!)).toBeCloseTo(0.211, 2);
    expect(haversineMiles(FALLBACK_HOME, cams[1]!)).toBeCloseTo(0.209, 2);
  });
  it('is zero for the same point and symmetric', () => {
    expect(haversineMiles(FALLBACK_HOME, FALLBACK_HOME)).toBe(0);
    expect(haversineMiles(cams[0]!, cams[2]!)).toBeCloseTo(haversineMiles(cams[2]!, cams[0]!), 10);
  });
});

describe('withinRadius', () => {
  it('filters by radius, drops invalid coordinates, sorts nearest first', () => {
    const out = withinRadius(cams, FALLBACK_HOME, 0.5);
    expect(out.map((c) => c.id)).toEqual(['amsterdam-181', 'audubon-181', 'amsterdam-178']);
    expect(out.every((c) => c.distanceMi <= 0.5)).toBe(true);
  });
  it('honours small radii', () => {
    expect(withinRadius(cams, FALLBACK_HOME, 0.1)).toEqual([]);
  });
});

describe('helpers', () => {
  it('validates coordinates', () => {
    expect(isValidLatLon({ lat: 40.8, lon: -73.9 })).toBe(true);
    expect(isValidLatLon({ lat: 91, lon: 0 })).toBe(false);
    expect(isValidLatLon(null)).toBe(false);
  });
  it('computes bearings', () => {
    expect(bearingDegrees({ lat: 40, lon: -74 }, { lat: 41, lon: -74 })).toBeCloseTo(0, 5);
    expect(bearingDegrees(FALLBACK_HOME, cams[0]!)).toBeGreaterThan(180); // camera is south-west of home
  });
  it('formats distances', () => {
    expect(formatMiles(0.05)).toBe('264 ft');
    expect(formatMiles(0.3)).toBe('0.3 mi');
    expect(formatMiles(0.21)).toBe('0.21 mi');
  });
});
