// Offline evaluation: run the production gap analysis over real frames.
//
// Inputs (produced by the camera-discovery GitHub Action):
//   feasibility/discovery.json   - cameras + frame list
//   feasibility/detections.json  - DETR boxes per frame (same model as Workers AI)
//   seed/calibrations.json       - lane polygons drawn on those frames
// Output: a per-frame table on stdout and feasibility/eval.json.
//
// Run: npm run eval

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeCurbGaps, type LaneStates } from '../shared/curb-gaps';
import type { Region } from '../shared/types';
import { cleanVehicles, parseObjectDetections } from '../worker/analysis/vehicles';

// Run from the project root (npm run eval).
const root = process.cwd();
const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

interface FrameDetections {
  n: number;
  file: string;
  detr: unknown[];
}

const discovery = read('feasibility/discovery.json') as { generatedAt: string; nearby: { id: string; frames: { n: number; fetchedAt: string }[] }[] };
const discoveryFrames = new Map(discovery.nearby.flatMap((c) => c.frames.map((f) => [`${c.id}:${f.n}`, Date.parse(f.fetchedAt)] as const)));
const detections = read('feasibility/detections.json') as Record<string, { name: string; distanceMi: number; frames: FrameDetections[] }>;
const seed = read('seed/calibrations.json') as { cameras: Record<string, { regions: Region[]; referenceWidth: number; referenceHeight: number }> };

const out: unknown[] = [];
for (const [cameraId, cal] of Object.entries(seed.cameras)) {
  const cam = detections[cameraId];
  if (!cam) {
    console.log(`No recorded detections for ${cameraId}`);
    continue;
  }
  console.log(`\n${cam.name} (${cam.distanceMi} mi) [${cameraId}]`);
  let state: LaneStates | undefined;
  const t0 = Date.parse(discovery.generatedAt);
  for (const frame of cam.frames) {
    const objects = cleanVehicles(parseObjectDetections(frame.detr, cal.referenceWidth, cal.referenceHeight), 0.35);
    const fetchedAt = discoveryFrames.get(`${cameraId}:${frame.n}`) ?? t0 + frame.n * 4000;
    const result = analyzeCurbGaps(objects, cal.regions, { imageWidth: cal.referenceWidth, imageHeight: cal.referenceHeight, nowMs: fetchedAt, state });
    state = result.state;
    const lanes = result.lanes
      .map((l) => `${l.regionId}: ${l.parkedVehicles} parked, observed ${Math.round(l.observedFraction * 100)}%, px/m ${l.pxPerMetre.start}->${l.pxPerMetre.end}, calSigma ${l.calibrationSigmaM} m`)
      .join(' | ');
    const grid = Object.values(state)[0]?.logodds.map((l) => (l < -0.4 ? '.' : l < 0.85 ? '?' : '#')).join('') ?? '';
    console.log(
      `  frame ${frame.n}: ${result.vehicles} vehicles, status=${result.status} conf=${result.confidence}` +
        (result.reason ? ` reason=${result.reason}` : '') +
        `\n    ${lanes}\n    grid ${grid}` +
        result.candidates.map((g) => `\n    gap ${g.start.toFixed(2)}-${g.end.toFixed(2)} ${g.lengthM} m need ${g.needM} pLen=${g.pLength} pFree=${g.pFree} far=${g.farFactor} conf=${g.confidence} ${g.status}`).join(''),
    );
    out.push({ cameraId, frame: frame.n, file: frame.file, status: result.status, vehicles: result.vehicles, parked: result.parkedVehicles, candidates: result.candidates, roles: result.objects.map((o) => o.role) });
  }
}
writeFileSync(join(root, 'feasibility/eval.json'), JSON.stringify(out, null, 1));
