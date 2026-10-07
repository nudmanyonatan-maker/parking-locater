// Parsing and cleanup of raw object-detector output.

import { VEHICLE_LABELS } from '../../shared/curb-gaps';
import type { DetectedObject } from '../../shared/types';

interface RawBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

function isRawDetection(v: unknown): v is { label: string; score: number; box: RawBox } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const b = o.box as Record<string, unknown> | undefined;
  return (
    typeof o.label === 'string' &&
    typeof o.score === 'number' &&
    !!b &&
    ['xmin', 'ymin', 'xmax', 'ymax'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]))
  );
}

/**
 * Parse Workers AI object-detection output (@cf/facebook/detr-resnet-50):
 * an array of { label, score, box: { xmin, ymin, xmax, ymax } } in pixels.
 * Also accepts `{ result: [...] }` and already-normalized boxes. Invalid
 * entries are dropped. Output boxes are normalized to 0..1.
 */
export function parseObjectDetections(raw: unknown, width: number, height: number): DetectedObject[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { result?: unknown }).result) ? (raw as { result: unknown[] }).result : null;
  if (!list) throw new Error('Unexpected detector response shape');
  const valid = list.filter(isRawDetection);
  const normalized = valid.length > 0 && valid.every((d) => d.box.xmax <= 1.0001 && d.box.ymax <= 1.0001);
  const sx = normalized ? 1 : width;
  const sy = normalized ? 1 : height;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return valid
    .map((d) => {
      const x0 = clamp01(Math.min(d.box.xmin, d.box.xmax) / sx);
      const x1 = clamp01(Math.max(d.box.xmin, d.box.xmax) / sx);
      const y0 = clamp01(Math.min(d.box.ymin, d.box.ymax) / sy);
      const y1 = clamp01(Math.max(d.box.ymin, d.box.ymax) / sy);
      return { label: d.label.toLowerCase(), score: Math.min(1, Math.max(0, d.score)), box: { xmin: x0, ymin: y0, xmax: x1, ymax: y1 } };
    })
    .filter((d) => d.box.xmax - d.box.xmin > 0.002 && d.box.ymax - d.box.ymin > 0.002);
}

export function iou(a: DetectedObject['box'], b: DetectedObject['box']): number {
  const ix = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin));
  const iy = Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
  const inter = ix * iy;
  const union = (a.xmax - a.xmin) * (a.ymax - a.ymin) + (b.xmax - b.xmin) * (b.ymax - b.ymin) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Keep vehicles only and drop duplicates:
 *  - class-agnostic NMS: DETR often reports one vehicle twice (e.g. "car" 0.96
 *    and "truck" 0.86 on an identical box);
 *  - part boxes: a box at least 85% inside a kept box that shares 2+ edges
 *    with it (within 2 px) is a sub-part of the same vehicle. A partly hidden
 *    car behind another does not share edges, so it survives.
 */
export function cleanVehicles(objects: DetectedObject[], minScore: number, iouThreshold = 0.6, imageWidth = 352, imageHeight = 240): DetectedObject[] {
  const vehicles = objects
    .filter((o) => (VEHICLE_LABELS as readonly string[]).includes(o.label) && o.score >= minScore)
    .sort((a, b) => b.score - a.score);
  const area = (b: DetectedObject['box']) => Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
  const inter = (a: DetectedObject['box'], b: DetectedObject['box']) =>
    Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin)) * Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
  const tx = 2 / imageWidth;
  const ty = 2 / imageHeight;
  const kept: DetectedObject[] = [];
  for (const v of vehicles) {
    if (kept.some((k) => iou(k.box, v.box) >= iouThreshold)) continue;
    const isPart = kept.some((k) => {
      if (inter(k.box, v.box) < 0.85 * area(v.box)) return false;
      const shared = [
        Math.abs(k.box.xmin - v.box.xmin) <= tx,
        Math.abs(k.box.xmax - v.box.xmax) <= tx,
        Math.abs(k.box.ymin - v.box.ymin) <= ty,
        Math.abs(k.box.ymax - v.box.ymax) <= ty,
      ].filter(Boolean).length;
      return shared >= 2;
    });
    if (!isPart) kept.push(v);
  }
  return kept;
}
