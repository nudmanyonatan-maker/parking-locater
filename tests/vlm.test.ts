import { describe, expect, it } from 'vitest';
import type { ParkingCandidate } from '../shared/types';
import { applyVerdict, describeLocation, parseVerdict } from '../worker/analysis/vlm';

const candidate: ParkingCandidate = {
  cameraId: 'c',
  regionId: 'r',
  streetLabel: 'W 181st St',
  spaces: 1,
  confidence: 0.7,
  status: 'likely_available',
  gapStart: 0.4,
  gapEnd: 0.55,
  polygon: [[0.1, 0.8], [0.2, 0.8], [0.2, 0.9], [0.1, 0.9]],
  lat: 40.85,
  lon: -73.93,
  approximateLocation: true,
  reasons: [],
};

describe('vision-LLM second opinion', () => {
  it('describes where the gap is in words', () => {
    expect(describeLocation(candidate.polygon)).toBe('left side, lower part of the image (closer to the camera)');
    expect(describeLocation([[0.5, 0.2], [0.6, 0.3]])).toBe('middle, upper part of the image (farther away)');
  });

  it('parses an OpenAI-style JSON verdict and rejects junk', () => {
    const ok = { choices: [{ message: { content: '{"empty_space":true,"confidence":0.9,"reason":"gap behind van"}' } }] };
    expect(parseVerdict(ok)).toEqual({ emptySpace: true, confidence: 0.9, reason: 'gap behind van' });
    expect(parseVerdict({ choices: [{ message: { content: 'not json' } }] })).toBeNull();
    expect(parseVerdict({ response: 'yes' })).toBeNull();
  });

  it('downgrades a candidate the model disagrees with and never upgrades', () => {
    const down = applyVerdict(candidate, false, 'Vision model: looks taken', 0.6);
    expect(down.confidence).toBeCloseTo(0.45, 3);
    expect(down.status).toBe('possible');
    const up = applyVerdict({ ...candidate, status: 'possible', confidence: 0.5 }, true, 'Vision model: looks open', 0.6);
    expect(up.status).toBe('possible');
    expect(applyVerdict(candidate, null, 'n/a', 0.6).confidence).toBe(0.7);
  });
});
