// API tests: the real Hono app over a node:sqlite D1 shim, with TMC, the
// geocoder and Workers AI faked (see tests/helpers/harness.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiError,
  AppSettings,
  Calibration,
  CameraDetail,
  CameraPreference,
  CameraSummary,
  Detection,
  DetectionHistoryItem,
  HealthResponse,
  ParkingCurrentResponse,
} from '../shared/types';
import { claimAnalysisSlot } from '../worker/db';
import { createApp } from '../worker/index';
import { ADMIN_TOKEN, ageDetections, AUDUBON, CAM, createHarness, FRAME, FRAME_HASH, watchAndCalibrate, type Harness } from './helpers/harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  expect(h.unexpected).toEqual([]);
  vi.unstubAllGlobals();
});

const json = async <T>(res: Response) => (await res.json()) as T;
const sync = () => h.call('/api/cameras/sync', { method: 'POST', admin: true });

describe('basics', () => {
  it('reports health with security headers', async () => {
    const res = await h.call('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const body = await json<HealthResponse>(res);
    expect(body.ok).toBe(true);
    expect(body.checks.db).toEqual({ ok: true });
    expect(body.checks.admin?.ok).toBe(true);
    expect(body.checks.ai?.ok).toBe(true);
    expect(body.checks.push?.ok).toBe(false);
    expect(body.checks.catalog?.ok).toBe(false);
    expect(body.checks.lastDetectionAt).toEqual({ ok: true, detail: 'never' });
  });

  it('returns ApiError JSON for unknown API routes', async () => {
    const res = await h.call('/api/nope');
    expect(res.status).toBe(404);
    expect((await json<ApiError>(res)).error).toBe('not_found');
  });

  it('hides internal errors behind a generic 500', async () => {
    const broken = { prepare: () => { throw new Error('D1 exploded at secret.ts:12'); } } as unknown as D1Database;
    const app = createApp();
    const res = await app.request('/api/settings', {}, { ...h.env, DB: broken }, h.ctx);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'internal_error' });
    expect(text).not.toContain('secret.ts');

    const health = await app.request('/api/health', {}, { ...h.env, DB: broken }, h.ctx);
    expect(health.status).toBe(503);
    expect((await json<HealthResponse>(health)).ok).toBe(false);
  });

  it('rejects malformed JSON bodies', async () => {
    const res = await h.call('/api/settings', { method: 'PUT', admin: true, body: '{oops', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error).toBe('invalid_json');
  });
});

describe('admin auth', () => {
  it('requires the bearer token', async () => {
    expect((await h.call('/api/auth/check')).status).toBe(401);
    const wrong = await h.call('/api/auth/check', { headers: { Authorization: `Bearer ${'y'.repeat(32)}` } });
    expect(wrong.status).toBe(401);
    expect((await json<ApiError>(wrong)).error).toBe('unauthorized');
    const ok = await h.call('/api/auth/check', { admin: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('locks admin routes when ADMIN_TOKEN is missing or too short', async () => {
    for (const token of [undefined, 'short-token']) {
      const app = createApp();
      const res = await app.request('/api/auth/check', { headers: { Authorization: `Bearer ${token}` } }, { ...h.env, ADMIN_TOKEN: token }, h.ctx);
      expect(res.status).toBe(503);
      expect((await json<ApiError>(res)).error).toBe('admin_not_configured');
    }
  });

  it('does not accept a token prefix', async () => {
    const res = await h.call('/api/auth/check', { headers: { Authorization: `Bearer ${ADMIN_TOKEN.slice(0, 31)}` } });
    expect(res.status).toBe(401);
  });
});

describe('camera catalog', () => {
  it('syncs on first use: geocodes home, keeps cameras within 1 mile, nearest first', async () => {
    const res = await h.call('/api/cameras');
    expect(res.status).toBe(200);
    const cameras = await json<CameraSummary[]>(res);
    expect(cameras.map((c) => c.id)).toEqual([CAM.amsterdam, CAM.audubon, CAM.stNicholas]);
    expect(cameras[0]!.distanceMi).toBeCloseTo(0.209, 2);
    expect(cameras[2]!.catalogOnline).toBe(false);
    expect(cameras[2]!.frame.freshness).toBe('offline');
    expect(cameras[0]).toMatchObject({
      preference: { usefulness: 'unknown', notes: null, streetLabel: null, updatedAt: null },
      calibrated: false,
      latest: null,
      latestAgeSeconds: null,
      frame: { freshness: 'unknown', consecutiveFailures: 0 },
    });

    const settings = await json<AppSettings>(await h.call('/api/settings'));
    expect(settings.home).toMatchObject({ lat: 40.851304, lon: -73.930153, source: 'nyc-geosearch' });

    // Fresh catalog: no second upstream call.
    const catalogCalls = () => h.fetch.mock.calls.filter(([u]) => String(u).startsWith('https://webcams.nyctmc.org/api/cameras/?')).length;
    await h.call('/api/cameras');
    expect(catalogCalls()).toBe(1);
  });

  it('filters by radius and validates it', async () => {
    await sync();
    const near = await json<CameraSummary[]>(await h.call('/api/cameras/nearby?radius=0.21'));
    expect(near.map((c) => c.id)).toEqual([CAM.amsterdam]);
    const all = await json<CameraSummary[]>(await h.call('/api/cameras/nearby'));
    expect(all).toHaveLength(3);
    for (const bad of ['0', '2', 'abc', '-1']) {
      const res = await h.call(`/api/cameras/nearby?radius=${bad}`);
      expect(res.status).toBe(400);
      expect((await json<ApiError>(res)).error).toBe('validation_failed');
    }
  });

  it('still answers when the catalog is down', async () => {
    h.catalogMode.ok = false;
    const res = await h.call('/api/cameras');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    const manual = await sync();
    expect(manual.status).toBe(502);
    expect((await json<ApiError>(manual)).error).toBe('catalog_unavailable');
  });

  it('returns camera detail and 404 for unknown cameras', async () => {
    await sync();
    const detail = await json<CameraDetail>(await h.call(`/api/cameras/${CAM.amsterdam}`));
    expect(detail).toMatchObject({ id: CAM.amsterdam, calibration: null, previous: null, imageUrl: `/api/cameras/${CAM.amsterdam}/image` });
    const missing = await h.call(`/api/cameras/${CAM.centralParkWest}`);
    expect(missing.status).toBe(404);
    expect((await json<ApiError>(missing)).error).toBe('camera_not_found');
    expect((await h.call('/api/cameras/bad_id!')).status).toBe(400);
  });
});

describe('usefulness', () => {
  beforeEach(async () => {
    await sync();
  });

  it('validates the body', async () => {
    const res = await h.call(`/api/cameras/${CAM.audubon}/usefulness`, { method: 'POST', admin: true, json: { usefulness: 'maybe' } });
    expect(res.status).toBe(400);
    const body = await json<ApiError>(res);
    expect(body.error).toBe('validation_failed');
    expect(body.details).toEqual([expect.objectContaining({ path: 'usefulness' })]);
    const long = await h.call(`/api/cameras/${CAM.audubon}/usefulness`, { method: 'POST', admin: true, json: { usefulness: 'yes', notes: 'x'.repeat(501) } });
    expect(long.status).toBe(400);
  });

  it('requires admin', async () => {
    const res = await h.call(`/api/cameras/${CAM.audubon}/usefulness`, { method: 'POST', json: { usefulness: 'yes' } });
    expect(res.status).toBe(401);
  });

  it('stores the preference and keeps omitted fields', async () => {
    const first = await h.call(`/api/cameras/${CAM.audubon}/usefulness`, {
      method: 'POST',
      admin: true,
      json: { usefulness: 'yes', notes: 'Left curb is visible', streetLabel: 'W 181st St' },
    });
    expect(first.status).toBe(200);
    expect(await json<CameraPreference>(first)).toMatchObject({ usefulness: 'yes', notes: 'Left curb is visible', streetLabel: 'W 181st St' });

    const second = await json<CameraPreference>(
      await h.call(`/api/cameras/${CAM.audubon}/usefulness`, { method: 'POST', admin: true, json: { usefulness: 'no', streetLabel: null } }),
    );
    expect(second).toMatchObject({ usefulness: 'no', notes: 'Left curb is visible', streetLabel: null });
    expect(second.updatedAt).toEqual(expect.any(String));

    const missing = await h.call(`/api/cameras/${CAM.centralParkWest}/usefulness`, { method: 'POST', admin: true, json: { usefulness: 'yes' } });
    expect(missing.status).toBe(404);
  });
});

describe('calibration', () => {
  const lane = (points: number[][], extra: Record<string, unknown> = {}) => ({
    regions: [{ id: 'lane-1', kind: 'parking', points, ...extra }],
    referenceWidth: 352,
    referenceHeight: 240,
  });
  const post = (body: unknown) => h.call(`/api/cameras/${CAM.audubon}/calibration`, { method: 'POST', admin: true, json: body });
  const details = async (res: Response) => (await json<ApiError>(res)).details as { path: string; message: string }[];

  beforeEach(async () => {
    await sync();
  });

  it('ships the W 181st St lane with its hydrants and keeps hydrants when saving', async () => {
    const seeded = await json<Calibration>(await h.call(`/api/cameras/${CAM.audubon}/calibration`));
    expect(seeded.regions[0]).toMatchObject({ id: 'lane-181-south', hydrantsM: [5, 31.4] });
    const lane = { id: 'lane', kind: 'parking', points: [[0.128, 1], [0.307, 1], [0.432, 0.533], [0.386, 0.533]], hydrantsM: [20, 4] };
    const saved = await json<Calibration>(await post({ regions: [lane], referenceWidth: 352, referenceHeight: 240 }));
    expect(saved.regions[0]!.hydrantsM).toEqual([4, 20]);
    expect((await post({ regions: [{ ...lane, hydrantsM: [-1] }], referenceWidth: 352, referenceHeight: 240 })).status).toBe(400);
  });

  it('rejects a non-convex (crossed) parking quad', async () => {
    const res = await post(lane([[0.1, 0.9], [0.4, 0.5], [0.4, 0.9], [0.1, 0.5]]));
    expect(res.status).toBe(400);
    expect(await details(res)).toEqual([expect.objectContaining({ path: 'regions.0.points', message: expect.stringContaining('convex') })]);
  });

  it('rejects a parking lane that is not exactly 4 points', async () => {
    const res = await post(lane([[0.1, 0.9], [0.3, 0.9], [0.4, 0.6], [0.3, 0.5], [0.1, 0.5]]));
    expect(res.status).toBe(400);
    expect((await details(res))[0]).toMatchObject({ path: 'regions.0.points', message: expect.stringContaining('exactly 4') });
  });

  it('rejects out-of-range coordinates and other bad fields', async () => {
    const res = await post(lane([[0.1, 1.2], [0.3, 0.9], [0.4, 0.6], [0.1, 0.5]]));
    expect(res.status).toBe(400);
    expect((await details(res))[0]!.path).toBe('regions.0.points.0.1');

    const kinds = await post({ ...lane([[0.1, 0.9], [0.3, 0.9], [0.4, 0.6], [0.1, 0.5]]), referenceWidth: 8 });
    expect((await details(kinds)).map((d) => d.path)).toEqual(['referenceWidth']);

    const dup = await post({
      regions: [
        { id: 'a', kind: 'ignore', points: [[0, 0], [0.2, 0], [0.2, 0.2]] },
        { id: 'a', kind: 'restricted', points: [[0.5, 0.5], [0.6, 0.5], [0.6, 0.6]] },
      ],
      referenceWidth: 352,
      referenceHeight: 240,
    });
    expect((await details(dup)).map((d) => d.path)).toEqual(['regions.1.id']);

    const capacity = await post(lane([[0.1, 0.9], [0.3, 0.9], [0.4, 0.6], [0.1, 0.5]], { capacity: 41 }));
    expect((await details(capacity))[0]!.path).toBe('regions.0.capacity');
  });

  it('rejects lane anchors far from home', async () => {
    const res = await post(lane([[0.1, 0.9], [0.3, 0.9], [0.4, 0.6], [0.1, 0.5]], { anchor: { lat: 40.758, lon: -73.9855 } }));
    expect(res.status).toBe(400);
    expect((await details(res))[0]!.path).toBe('regions.0.anchor');
  });

  it('stores a valid calibration, reads it back and deletes it', async () => {
    const body = {
      ...AUDUBON.calibration,
      regions: [
        ...AUDUBON.calibration.regions,
        { id: 'lane-2', kind: 'parking', points: [[0.6, 1], [0.7, 1], [0.6, 0.6], [0.55, 0.6]], anchor: { lat: 40.8489, lon: -73.9322 } },
        { id: 'hydrant', kind: 'restricted', points: [[0.2, 0.9], [0.25, 0.9], [0.25, 0.95]], capacity: 3 },
      ],
    };
    const res = await post(body);
    expect(res.status).toBe(200);
    const saved = await json<Calibration>(res);
    expect(saved.cameraId).toBe(CAM.audubon);
    expect(saved.regions).toHaveLength(4);
    expect(saved.regions[0]).toMatchObject({ id: 'lane-181-south', capacity: 8, streetLabel: 'W 181st St at Audubon Ave' });
    expect(saved.regions[2]).toMatchObject({ id: 'lane-2', capacity: 6, anchor: { lat: 40.8489, lon: -73.9322 } });
    expect(saved.regions[3]).not.toHaveProperty('capacity'); // parking-only field dropped

    const readBack = await json<Calibration>(await h.call(`/api/cameras/${CAM.audubon}/calibration`));
    expect(readBack).toEqual(saved);
    const summary = (await json<CameraSummary[]>(await h.call('/api/cameras'))).find((c) => c.id === CAM.audubon)!;
    expect(summary.calibrated).toBe(true);

    expect((await h.call(`/api/cameras/${CAM.audubon}/calibration`, { method: 'DELETE' })).status).toBe(401);
    const del = await h.call(`/api/cameras/${CAM.audubon}/calibration`, { method: 'DELETE', admin: true });
    expect(await del.json()).toEqual({ ok: true });
    expect(await (await h.call(`/api/cameras/${CAM.audubon}/calibration`)).json()).toBeNull();
  });
});

describe('settings', () => {
  it('returns defaults and validates updates', async () => {
    const defaults = await json<AppSettings>(await h.call('/api/settings'));
    expect(defaults).toMatchObject({ radiusMi: 0.5, minConfidence: 0.6, notificationsEnabled: false, backgroundMode: 'when_alerts_on' });

    expect((await h.call('/api/settings', { method: 'PUT', json: { radiusMi: 0.75 } })).status).toBe(401);

    const bad = await h.call('/api/settings', { method: 'PUT', admin: true, json: { radiusMi: 2, colour: 'red' } });
    expect(bad.status).toBe(400);
    const err = await json<ApiError>(bad);
    expect(err.error).toBe('validation_failed');
    expect((err.details as { path: string }[]).map((d) => d.path).sort()).toEqual(['colour', 'radiusMi']);

    const ok = await h.call('/api/settings', { method: 'PUT', admin: true, json: { radiusMi: 0.75, notificationsEnabled: true, minConfidence: 0.5 } });
    expect(ok.status).toBe(200);
    expect(await json<AppSettings>(ok)).toMatchObject({ radiusMi: 0.75, notificationsEnabled: true, minConfidence: 0.5 });
    expect(await json<AppSettings>(await h.call('/api/settings'))).toMatchObject({ radiusMi: 0.75, notificationsEnabled: true });
  });

  it('re-geocodes home on request', async () => {
    const res = await h.call('/api/settings/geocode', { method: 'POST', admin: true });
    expect(res.status).toBe(200);
    expect((await json<AppSettings>(res)).home.source).toBe('nyc-geosearch');
    expect(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM cameras').get()).toEqual({ n: 3 });
  });
});

describe('image proxy', () => {
  beforeEach(async () => {
    await sync();
  });

  it('proxies the JPEG with frame headers', async () => {
    const res = await h.call(`/api/cameras/${CAM.audubon}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=2');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Hash')).toBe(FRAME_HASH.slice(0, 16));
    expect(res.headers.get('X-Frame-Freshness')).toBe('live');
    expect(Date.parse(res.headers.get('X-Frame-Fetched-At') ?? '')).not.toBeNaN();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FRAME);

    const upstream = h.fetch.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/image'));
    expect(upstream).toMatch(new RegExp(`^https://webcams\\.nyctmc\\.org/api/cameras/${CAM.audubon}/image\\?t=\\d+$`));
  });

  it('is not an open proxy', async () => {
    const res = await h.call(`/api/cameras/${CAM.centralParkWest}/image`);
    expect(res.status).toBe(404);
    expect((await h.call('/api/cameras/..%2F..%2Fetc/image')).status).toBe(400);
    expect(h.fetch.mock.calls.some(([u]) => String(u).includes('/image'))).toBe(false);
  });

  it('maps upstream failures to 502/504 and marks the camera offline', async () => {
    h.frameMode.set(CAM.audubon, 'http_500');
    const failed = await h.call(`/api/cameras/${CAM.audubon}/image`);
    expect(failed.status).toBe(502);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect((await json<ApiError>(failed)).error).toBe('camera_unavailable');

    h.frameMode.set(CAM.audubon, 'timeout');
    const slow = await h.call(`/api/cameras/${CAM.audubon}/image`);
    expect(slow.status).toBe(504);
    expect((await json<ApiError>(slow)).error).toBe('camera_timeout');

    const detail = await json<CameraDetail>(await h.call(`/api/cameras/${CAM.audubon}`));
    expect(detail.frame).toMatchObject({ freshness: 'offline', consecutiveFailures: 2 });
    expect(detail.frame.lastError).toContain('timeout');

    h.frameMode.set(CAM.audubon, 'ok');
    expect((await h.call(`/api/cameras/${CAM.audubon}/image`)).headers.get('X-Frame-Freshness')).toBe('live');
  });

  it('rejects responses that are not a usable JPEG', async () => {
    for (const mode of ['html', 'tiny'] as const) {
      h.frameMode.set(CAM.audubon, mode);
      const res = await h.call(`/api/cameras/${CAM.audubon}/image`);
      expect(res.status).toBe(502);
      expect((await json<ApiError>(res)).error).toBe('bad_image');
    }
  });

  it('reports a camera that is being serviced as unavailable', async () => {
    h.frameMode.set(CAM.audubon, 'serviced');
    const res = await h.call(`/api/cameras/${CAM.audubon}/image`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'camera_unavailable', message: 'This camera is being serviced right now' });
  });

  it('marks frames whose EXIF capture time is old as stale', async () => {
    h.frameMode.set(CAM.audubon, 'old_exif');
    const res = await h.call(`/api/cameras/${CAM.audubon}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Freshness')).toBe('stale');
    const stored = h.db.sqlite.prepare('SELECT last_capture_at FROM camera_frame_state WHERE camera_id = ?').get(CAM.audubon);
    expect(stored).toEqual({ last_capture_at: '2026-10-07T04:26:29.000Z' });
    const detail = await json<CameraDetail>(await h.call(`/api/cameras/${CAM.audubon}`));
    expect(detail.frame.freshness).toBe('stale');
  });

  it('reports catalog-offline cameras as offline', async () => {
    const res = await h.call(`/api/cameras/${CAM.stNicholas}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Freshness')).toBe('offline');
  });
});

describe('analysis', () => {
  const analyze = (id: string, opts: { admin?: boolean; force?: boolean } = {}) =>
    h.call(`/api/cameras/${id}/analyze${opts.force ? '?force=1' : ''}`, { method: 'POST', admin: opts.admin });

  beforeEach(async () => {
    await sync();
    await watchAndCalibrate(h);
  });

  it('analyzes a calibrated camera with the vehicle detector', async () => {
    const res = await analyze(CAM.audubon, { admin: true });
    expect(res.status).toBe(200);
    const d = await json<Detection>(res);
    expect(d).toMatchObject({
      cameraId: CAM.audubon,
      freshness: 'live',
      frameHash: FRAME_HASH,
      detector: 'curb-gap+workers-ai/detr-resnet-50',
      status: 'possible',
      reason: null,
      error: null,
    });
    expect(d.id).toEqual(expect.any(Number));
    expect(d.vehiclesDetected).toBe(4); // the synthetic street has 4 parked cars
    expect(d.objects.every((o) => o.box.xmax <= 1)).toBe(true);
    expect(d.candidates.length).toBeGreaterThan(0);
    expect(d.candidates[0]).toMatchObject({ cameraId: CAM.audubon, regionId: 'lane-181-south', streetLabel: 'W 181st St at Audubon Ave', id: expect.any(Number) });
    expect(d.candidateSpaces).toBe(d.candidates.reduce((s, c) => s + c.spaces, 0));

    expect(h.ai.run).toHaveBeenCalledTimes(1);
    const [model, input] = h.ai.run.mock.calls[0]!;
    expect(model).toBe('@cf/facebook/detr-resnet-50');
    expect((input as { image: number[] }).image).toHaveLength(FRAME.length);

    // Stored exactly as returned.
    const detail = await json<CameraDetail>(await h.call(`/api/cameras/${CAM.audubon}`));
    expect(detail.latest).toEqual(d);
    expect(detail.latestAgeSeconds).toBeLessThan(5);
  });

  it('applies the cooldown, also to admins forcing within 5 s', async () => {
    const first = await json<Detection>(await analyze(CAM.audubon, { admin: true }));
    const again = await json<Detection>(await analyze(CAM.audubon));
    expect(again.id).toBe(first.id);
    const forced = await json<Detection>(await analyze(CAM.audubon, { admin: true, force: true }));
    expect(forced.id).toBe(first.id);
    expect(h.ai.run).toHaveBeenCalledTimes(1);

    ageDetections(h, CAM.audubon, 10);
    const forcedLater = await json<Detection>(await analyze(CAM.audubon, { admin: true, force: true }));
    expect(forcedLater.id).toBeGreaterThan(first.id);
    // Public callers cannot force.
    const publicForce = await json<Detection>(await analyze(CAM.audubon, { force: true }));
    expect(publicForce.id).toBe(forcedLater.id);
  });

  it('runs one analysis for a burst of concurrent public requests', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => analyze(CAM.audubon)));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
    const ids = new Set(await Promise.all(results.map(async (r) => (await json<Detection>(r)).id)));
    expect(ids.size).toBe(1);
    expect(h.ai.run).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls.filter(([u]) => String(u).includes('/image'))).toHaveLength(1);
    expect(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM detections').get()).toEqual({ n: 1 });
  });

  it('claims the cooldown slot atomically in D1 (one winner across isolates)', async () => {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 45_000).toISOString();
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimAnalysisSlot(h.env.DB, CAM.amsterdam, now, cutoff)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    // Once the cooldown has passed, the next claim wins again.
    expect(await claimAnalysisSlot(h.env.DB, CAM.amsterdam, new Date(Date.now() + 46_000).toISOString(), new Date(Date.now() + 1000).toISOString())).toBe(true);
  });

  it('does not analyze while another isolate holds the slot', async () => {
    // Another isolate claimed the slot a moment ago and is still running.
    const holdSlot = () =>
      h.db.sqlite.prepare('INSERT OR REPLACE INTO analysis_slots (camera_id, claimed_at) VALUES (?, ?)').run(CAM.audubon, new Date().toISOString());
    holdSlot();
    const busy = await analyze(CAM.audubon);
    expect(busy.status).toBe(429);
    expect((await json<ApiError>(busy)).error).toBe('analysis_in_progress');

    // With an older stored result, callers get that one, as inside the cooldown.
    h.db.sqlite.prepare('DELETE FROM analysis_slots').run();
    const old = await json<Detection>(await analyze(CAM.audubon));
    ageDetections(h, CAM.audubon, 600);
    holdSlot();
    const again = await json<Detection>(await analyze(CAM.audubon));
    expect(again.id).toBe(old.id);
    expect(h.ai.run).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls.filter(([u]) => String(u).includes('/image'))).toHaveLength(1);
  });

  it('does not count an unchanged (frozen) camera image twice', async () => {
    // FRAME never changes in "ok" mode: still LIVE for 2 minutes, but no new information.
    const first = await json<Detection>(await analyze(CAM.audubon));
    const confidences = [first.candidates[0]!.confidence];
    for (let i = 0; i < 3; i++) {
      ageDetections(h, CAM.audubon, 45);
      const d = await json<Detection>(await analyze(CAM.audubon));
      expect(d).toMatchObject({ frameHash: FRAME_HASH, freshness: 'live', status: 'possible' });
      expect(d.notes).toContain('Same camera image as the last check; not counted again.');
      confidences.push(d.candidates[0]!.confidence);
    }
    for (const c of confidences) expect(c).toBeCloseTo(confidences[0]!, 2);

    // A new picture is new evidence again.
    h.frameMode.set(CAM.audubon, 'ticking');
    ageDetections(h, CAM.audubon, 45);
    const next = await json<Detection>(await analyze(CAM.audubon));
    expect(next.candidates[0]!.confidence).toBeGreaterThan(confidences[0]! + 0.05);
  });

  it('only lets the public analyze watched cameras', async () => {
    const res = await analyze(CAM.amsterdam);
    expect(res.status).toBe(403);
    expect((await json<ApiError>(res)).error).toBe('not_watched');
    expect((await analyze(CAM.centralParkWest)).status).toBe(404);
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('skips AI for uncalibrated cameras unless an admin asks', async () => {
    await h.call(`/api/cameras/${CAM.amsterdam}/usefulness`, { method: 'POST', admin: true, json: { usefulness: 'yes' } });
    const pub = await json<Detection>(await analyze(CAM.amsterdam));
    expect(pub).toMatchObject({ status: 'unknown', reason: 'needs_calibration', vehiclesDetected: 0, freshness: 'live' });
    expect(h.ai.run).not.toHaveBeenCalled();

    ageDetections(h, CAM.amsterdam, 60);
    const admin = await json<Detection>(await analyze(CAM.amsterdam, { admin: true }));
    expect(admin).toMatchObject({ status: 'unknown', reason: 'needs_calibration' });
    expect(admin.vehiclesDetected).toBeGreaterThan(0);
    expect(admin.objects.length).toBeGreaterThan(0);
    expect(h.ai.run).toHaveBeenCalledTimes(1);
  });

  it('stores frame failures and stale frames without calling AI', async () => {
    h.frameMode.set(CAM.audubon, 'http_500');
    const offline = await json<Detection>(await analyze(CAM.audubon, { admin: true }));
    expect(offline).toMatchObject({ status: 'unknown', reason: 'frame_unavailable', freshness: 'offline' });
    expect(offline.error).toContain('HTTP 500');

    ageDetections(h, CAM.audubon, 60);
    h.frameMode.set(CAM.audubon, 'timeout');
    const timeout = await json<Detection>(await analyze(CAM.audubon, { admin: true }));
    expect(timeout).toMatchObject({ reason: 'frame_unavailable', freshness: 'unknown' });

    // Same bytes for 10 minutes => frozen camera.
    ageDetections(h, CAM.audubon, 60);
    h.frameMode.set(CAM.audubon, 'ok');
    const old = new Date(Date.now() - 600_000).toISOString();
    h.db.sqlite
      .prepare('UPDATE camera_frame_state SET last_hash = ?, last_changed_at = ?, last_fetched_at = ?, consecutive_failures = 0 WHERE camera_id = ?')
      .run(FRAME_HASH, old, new Date(Date.now() - 30_000).toISOString(), CAM.audubon);
    const stale = await json<Detection>(await analyze(CAM.audubon, { admin: true }));
    expect(stale).toMatchObject({ status: 'unknown', reason: 'stale_frame', freshness: 'stale', frameHash: FRAME_HASH });

    // Bytes change but the camera's own clock (EXIF) is far behind => also stale.
    ageDetections(h, CAM.audubon, 60);
    h.frameMode.set(CAM.audubon, 'old_exif');
    const oldExif = await json<Detection>(await analyze(CAM.audubon, { admin: true }));
    expect(oldExif).toMatchObject({ status: 'unknown', reason: 'stale_frame', freshness: 'stale' });
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('reports a missing AI binding and detector errors', async () => {
    const noAi = createHarness({ AI: undefined });
    await noAi.call('/api/cameras/sync', { method: 'POST', admin: true });
    await watchAndCalibrate(noAi);
    const d = await json<Detection>(await noAi.call(`/api/cameras/${CAM.audubon}/analyze`, { method: 'POST' }));
    expect(d).toMatchObject({ status: 'unknown', reason: 'detector_unavailable', freshness: 'live' });

    h.ai.run.mockRejectedValue(new Error('model exploded'));
    const failed = await json<Detection>(await analyze(CAM.audubon, { admin: true }));
    expect(failed).toMatchObject({ status: 'unknown', reason: 'detector_error' });
    expect(failed.error).toContain('model exploded');
  });

  it('lists history newest first and fills detail.previous', async () => {
    h.frameMode.set(CAM.audubon, 'ticking'); // a live camera: every fetch is a new picture
    const first = await json<Detection>(await analyze(CAM.audubon, { admin: true }));
    ageDetections(h, CAM.audubon, 120);
    const second = await json<Detection>(await analyze(CAM.audubon));
    expect(second.id).not.toBe(first.id);
    expect(second.frameHash).not.toBe(first.frameHash);
    // Evidence is fused across checks via the persisted lane grid: the opening seen twice is more certain.
    expect(second.candidates[0]!.confidence).toBeGreaterThan(first.candidates[0]!.confidence);
    const stored = h.db.sqlite.prepare('SELECT state_json FROM camera_lane_state WHERE camera_id = ?').get(CAM.audubon) as { state_json: string } | undefined;
    expect(Object.keys(JSON.parse(stored!.state_json))).toEqual(['lane-181-south']);
    expect(second).not.toHaveProperty('laneState');

    const history = await json<DetectionHistoryItem[]>(await h.call(`/api/cameras/${CAM.audubon}/history`));
    expect(history.map((i) => i.id)).toEqual([second.id, first.id]);
    expect(history[0]).toEqual({
      id: second.id,
      timestamp: second.timestamp,
      status: second.status,
      candidateSpaces: second.candidateSpaces,
      confidence: second.confidence,
      vehiclesDetected: second.vehiclesDetected,
      freshness: 'live',
      reason: null,
    });
    expect((await json<DetectionHistoryItem[]>(await h.call(`/api/cameras/${CAM.audubon}/history?limit=1`))).map((i) => i.id)).toEqual([second.id]);
    for (const bad of ['0', '201', '1.5', 'x']) expect((await h.call(`/api/cameras/${CAM.audubon}/history?limit=${bad}`)).status).toBe(400);

    const detail = await json<CameraDetail>(await h.call(`/api/cameras/${CAM.audubon}`));
    expect(detail.latest?.id).toBe(second.id);
    expect(detail.previous?.id).toBe(first.id);
  });
});

describe('parking/current', () => {
  beforeEach(async () => {
    await sync();
    await watchAndCalibrate(h);
  });

  it('summarizes current candidates from watched cameras', async () => {
    const d = await json<Detection>(await h.call(`/api/cameras/${CAM.audubon}/analyze`, { method: 'POST' }));
    const res = await h.call('/api/parking/current');
    expect(res.status).toBe(200);
    const body = await json<ParkingCurrentResponse>(res);
    expect(body.home).toMatchObject({ lat: 40.851304, lon: -73.930153 });
    expect(body.radiusMi).toBe(0.5);
    expect(body.minConfidence).toBe(0.6);
    expect(body.maxDetectionAgeSeconds).toBe(300);
    expect(body.watched.map((c) => c.id)).toEqual([CAM.audubon]);
    expect(body.nearby.map((c) => c.id)).toEqual([CAM.amsterdam, CAM.audubon, CAM.stNicholas]);
    expect(body.candidates.map((c) => c.id)).toEqual(d.candidates.map((c) => c.id));
    const confidences = body.candidates.map((c) => c.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
    expect(body.summary).toMatchObject({ state: 'possible', spots: d.candidateSpaces, updatedAt: d.timestamp });
    expect(body.summary.headline).toMatch(/^Maybe \d+ spots? nearby$/);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();

    const lastSeen = h.db.sqlite.prepare("SELECT value_json FROM application_settings WHERE key = 'app_last_seen_at'").get() as { value_json: string };
    expect(Date.now() - Date.parse(JSON.parse(lastSeen.value_json))).toBeLessThan(5000);
  });

  it('says unknown, not "no parking", when watched cameras could not see the curb', async () => {
    // Night: the detector finds no vehicles at all.
    h.ai.run.mockResolvedValue([]);
    const night = await json<Detection>(await h.call(`/api/cameras/${CAM.audubon}/analyze`, { method: 'POST' }));
    expect(night).toMatchObject({ status: 'unknown', reason: 'no_vehicles_detected', freshness: 'live' });
    const body = await json<ParkingCurrentResponse>(await h.call('/api/parking/current'));
    expect(body.summary).toMatchObject({ state: 'unknown', spots: 0, headline: 'No current camera data' });

    // Watched but not calibrated yet.
    await h.call(`/api/cameras/${CAM.amsterdam}/usefulness`, { method: 'POST', admin: true, json: { usefulness: 'yes' } });
    const uncalibrated = await json<Detection>(await h.call(`/api/cameras/${CAM.amsterdam}/analyze`, { method: 'POST' }));
    expect(uncalibrated).toMatchObject({ status: 'unknown', reason: 'needs_calibration', freshness: 'live' });
    expect((await json<ParkingCurrentResponse>(await h.call('/api/parking/current'))).summary.state).toBe('unknown');

    // One camera that can see its curb and finds it full makes it a definite "none".
    h.db.sqlite.prepare("UPDATE detections SET status = 'none', reason = NULL WHERE camera_id = ?").run(CAM.audubon);
    expect((await json<ParkingCurrentResponse>(await h.call('/api/parking/current'))).summary.state).toBe('none');
  });

  it('ignores detections older than maxDetectionAgeSeconds', async () => {
    await h.call(`/api/cameras/${CAM.audubon}/analyze`, { method: 'POST' });
    ageDetections(h, CAM.audubon, 600);
    const body = await json<ParkingCurrentResponse>(await h.call('/api/parking/current'));
    expect(body.candidates).toEqual([]);
    expect(body.summary).toMatchObject({ state: 'unknown', spots: 0, headline: 'No current camera data' });
    expect(body.summary.updatedAt).not.toBeNull();
    expect(body.watched[0]!.latestAgeSeconds).toBeGreaterThanOrEqual(600);
  });
});

describe('push subscriptions', () => {
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    expirationTime: null,
    keys: { p256dh: 'BOr4n_PdMLnc-Kk2Eo0SJqkqVnOEkWgN3l6mSaM8YC8', auth: 'tBHItJI5svbpez7KI4CCXg' },
  };

  it('reports config and manages subscriptions', async () => {
    expect(await (await h.call('/api/push/config')).json()).toEqual({ enabled: false, publicKey: null });

    expect((await h.call('/api/push/subscribe', { method: 'POST', json: subscription })).status).toBe(401);
    const bad = await h.call('/api/push/subscribe', { method: 'POST', admin: true, json: { ...subscription, keys: { p256dh: 'not base64!', auth: '' } } });
    expect(bad.status).toBe(400);
    const notPush = await h.call('/api/push/subscribe', { method: 'POST', admin: true, json: { ...subscription, endpoint: 'https://evil.example/hook' } });
    expect(notPush.status).toBe(400);
    const http = await h.call('/api/push/subscribe', { method: 'POST', admin: true, json: { ...subscription, endpoint: 'http://fcm.googleapis.com/x' } });
    expect(http.status).toBe(400);

    const ok = await h.call('/api/push/subscribe', { method: 'POST', admin: true, json: subscription });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const rows = () => h.db.sqlite.prepare('SELECT endpoint, enabled FROM notification_subscriptions').all();
    expect(rows()).toEqual([{ endpoint: subscription.endpoint, enabled: 1 }]);
    // Re-subscribing is an upsert.
    await h.call('/api/push/subscribe', { method: 'POST', admin: true, json: subscription });
    expect(rows()).toHaveLength(1);

    const unsub = await h.call('/api/push/unsubscribe', { method: 'POST', json: { endpoint: subscription.endpoint } });
    expect(unsub.status).toBe(200);
    expect(rows()).toEqual([]);
  });

  it('needs VAPID keys to send a test push', async () => {
    const res = await h.call('/api/push/test', { method: 'POST', admin: true });
    expect(res.status).toBe(503);
    expect((await json<ApiError>(res)).error).toBe('push_not_configured');
  });
});
