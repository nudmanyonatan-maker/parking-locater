import { describe, expect, it } from 'vitest';
import { cleanVehicles, iou, parseObjectDetections } from '../worker/analysis/vehicles';

describe('parseObjectDetections', () => {
  it('normalizes Workers AI DETR pixel boxes', () => {
    const out = parseObjectDetections([{ label: 'Car', score: 0.96, box: { xmin: 57, ymin: 194, xmax: 105, ymax: 233 } }], 352, 240);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('car');
    expect(out[0]!.box.xmin).toBeCloseTo(57 / 352, 6);
    expect(out[0]!.box.ymax).toBeCloseTo(233 / 240, 6);
  });
  it('accepts already-normalized boxes and the {result: []} wrapper', () => {
    const out = parseObjectDetections({ result: [{ label: 'car', score: 0.8, box: { xmin: 0.1, ymin: 0.2, xmax: 0.3, ymax: 0.4 } }] }, 352, 240);
    expect(out[0]!.box).toEqual({ xmin: 0.1, ymin: 0.2, xmax: 0.3, ymax: 0.4 });
  });
  it('drops malformed entries and clamps / orders coordinates', () => {
    const out = parseObjectDetections(
      [
        { label: 'car', score: 0.9, box: { xmin: 400, ymin: 10, xmax: 300, ymax: 50 } },
        { label: 'car', score: 'high', box: {} },
        null,
      ],
      352,
      240,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.box.xmin).toBeCloseTo(300 / 352, 6);
    expect(out[0]!.box.xmax).toBe(1);
  });
  it('throws on an unexpected response shape', () => {
    expect(() => parseObjectDetections({ error: 'nope' }, 352, 240)).toThrow();
  });
});

describe('cleanVehicles', () => {
  it('removes DETR duplicate car/truck boxes and non-vehicles', () => {
    // Real duplicate from the Audubon @ 181 frame: same box as car 0.96 and truck 0.86.
    const box = { xmin: 57 / 352, ymin: 194 / 240, xmax: 105 / 352, ymax: 233 / 240 };
    const out = cleanVehicles(
      [
        { label: 'truck', score: 0.86, box },
        { label: 'car', score: 0.96, box },
        { label: 'person', score: 0.99, box: { xmin: 0.5, ymin: 0.5, xmax: 0.52, ymax: 0.6 } },
        { label: 'car', score: 0.3, box: { xmin: 0.7, ymin: 0.5, xmax: 0.8, ymax: 0.6 } },
      ],
      0.5,
    );
    expect(out).toEqual([{ label: 'car', score: 0.96, box }]);
  });
  it('computes IoU', () => {
    expect(iou({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, { xmin: 0, ymin: 0, xmax: 1, ymax: 1 })).toBe(1);
    expect(iou({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, { xmin: 2, ymin: 2, xmax: 3, ymax: 3 })).toBe(0);
  });
});
