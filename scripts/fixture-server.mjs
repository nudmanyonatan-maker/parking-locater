#!/usr/bin/env node
// Dev-only stand-in for the NYC TMC camera API, built from the real data the
// camera-discovery GitHub Action recorded (feasibility/). Lets the whole app
// run locally with real frames and real (offline) DETR detections, without
// network access or a Cloudflare account.
//
//   GET /api/cameras/            catalog (same JSON shape as webcams.nyctmc.org)
//   GET /api/cameras/:id/image   that camera's recorded frames, one every 4 s
//   GET /detections/:sha256      recorded DETR output for the frame with that hash
//
// Usage: npm run dev:fixtures  (then set TMC_BASE_URL / DETECTOR=fixture in .dev.vars)

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8788);
const dir = join(process.cwd(), 'feasibility');
const discovery = JSON.parse(readFileSync(join(dir, 'discovery.json'), 'utf8'));
const detections = JSON.parse(readFileSync(join(dir, 'detections.json'), 'utf8'));

const cameras = [...discovery.nearby, ...discovery.context];
const catalog = cameras.map((c) => c.raw);
const framesById = new Map(cameras.map((c) => [c.id, c.frames.filter((f) => f.file)]));

// sha256 -> DETR detections (pixel boxes, Workers AI shape)
const bySha = new Map();
for (const cam of cameras) {
  const recorded = detections[cam.id]?.frames ?? [];
  for (const f of cam.frames) {
    const det = recorded.find((r) => r.n === f.n);
    if (f.sha256 && det) bySha.set(f.sha256, det.detr);
  }
}

const started = Date.now();
const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/api/cameras') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(catalog));

  const img = path.match(/^\/api\/cameras\/([\w-]+)\/image$/);
  if (img) {
    const frames = framesById.get(img[1]);
    if (!frames?.length) return send(res, 404, 'text/plain', 'not found');
    const frame = frames[Math.floor((Date.now() - started) / 4000) % frames.length];
    return send(res, 200, 'image/jpeg', readFileSync(join(dir, frame.file)));
  }

  const det = path.match(/^\/detections\/([0-9a-f]{64})$/);
  if (det) {
    const boxes = bySha.get(det[1]);
    return boxes ? send(res, 200, 'application/json', JSON.stringify(boxes)) : send(res, 404, 'application/json', '{"error":"unknown frame"}');
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, () => {
  console.log(`TMC fixture server on http://localhost:${PORT} (${catalog.length} cameras, ${bySha.size} recorded frames)`);
});
