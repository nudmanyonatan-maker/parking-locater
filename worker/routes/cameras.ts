// Camera endpoints under /api/cameras.
//   GET    /                     CameraSummary[] (all stored, nearest first)
//   GET    /nearby?radius=0.5    CameraSummary[] within radius (0 < r <= 1)
//   POST   /sync                 admin: resync from the TMC catalog -> {count}
//   GET    /:id                  CameraDetail
//   GET    /:id/image            JPEG proxied from TMC (stored cameras only; not an open proxy)
//   POST   /:id/analyze[?force=1] Detection (public: watched cameras only, always cooled down)
//   GET    /:id/history?limit=50 DetectionHistoryItem[] newest first
//   GET    /:id/calibration      Calibration | null
//   POST   /:id/calibration      admin: replace calibration
//   DELETE /:id/calibration      admin
//   POST   /:id/usefulness       admin: CameraPreference

import { Hono } from 'hono';
import { haversineMiles } from '../../shared/geo';
import { isAdmin, requireAdmin } from '../auth';
import { deleteCalibration, detectionHistory, getCalibrationRow, getPreferenceRow, toCalibration, toPreference, upsertCalibration, upsertPreference } from '../db';
import { HttpError, readJson, type AppContext, type AppEnv } from '../http';
import { analyzeCamera } from '../services/analysis';
import { cameraDetail, cameraSummaries, ensureCatalogFresh, requireCamera, syncCatalog } from '../services/cameras';
import { getFrameCached } from '../services/frames';
import { readSettings } from '../services/settings';
import { TmcError } from '../tmc';
import { CAMERA_ID_PATTERN, calibrationBody, parseOrThrow, usefulnessBody, type ValidationDetail } from '../validation';

/** Lane anchors must be this close to home (they are meant to be on nearby streets). */
const MAX_ANCHOR_DISTANCE_MI = 2;

export const cameraRoutes = new Hono<AppEnv>();

function cameraIdParam(c: AppContext): string {
  const id = c.req.param('id') ?? '';
  if (!CAMERA_ID_PATTERN.test(id)) throw new HttpError(400, 'invalid_camera_id', 'Camera ids are 1-64 letters, digits or dashes');
  return id;
}

/** Query parameter as a number, `fallback` when absent; 400 when malformed or out of range. */
function numberQuery(c: AppContext, name: string, fallback: number, valid: (n: number) => boolean, rule: string): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !valid(n)) {
    throw new HttpError(400, 'validation_failed', `${name}: ${rule}`, [{ path: name, message: rule }]);
  }
  return n;
}

function frameErrorStatus(e: TmcError): { status: 502 | 504; code: string } {
  if (e.code === 'timeout') return { status: 504, code: 'camera_timeout' };
  if (e.code === 'bad_image') return { status: 502, code: 'bad_image' };
  return { status: 502, code: 'camera_unavailable' };
}

cameraRoutes.get('/', async (c) => {
  await ensureCatalogFresh(c.env);
  return c.json(await cameraSummaries(c.env));
});

cameraRoutes.get('/nearby', async (c) => {
  const { radiusMi } = await readSettings(c.env);
  const radius = numberQuery(c, 'radius', radiusMi, (n) => n > 0 && n <= 1, 'Must be a number greater than 0 and at most 1');
  await ensureCatalogFresh(c.env);
  return c.json(await cameraSummaries(c.env, { radiusMi: radius }));
});

cameraRoutes.post('/sync', requireAdmin, async (c) => {
  try {
    return c.json({ count: await syncCatalog(c.env) });
  } catch (e) {
    if (e instanceof TmcError) throw new HttpError(502, 'catalog_unavailable', `Could not load the camera list: ${e.message}`);
    throw e;
  }
});

cameraRoutes.get('/:id', async (c) => c.json(await cameraDetail(c.env, cameraIdParam(c))));

cameraRoutes.get('/:id/image', async (c) => {
  const camera = await requireCamera(c.env, cameraIdParam(c));
  try {
    const { frame, state } = await getFrameCached(c.env, c.executionCtx, camera);
    return c.body(frame.bytes, 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=2',
      'X-Frame-Fetched-At': frame.fetchedAt,
      'X-Frame-Hash': frame.hash.slice(0, 16),
      'X-Frame-Freshness': state.freshness,
    });
  } catch (e) {
    if (!(e instanceof TmcError)) throw e;
    const { status, code } = frameErrorStatus(e);
    throw new HttpError(status, code, e.message);
  }
});

cameraRoutes.post('/:id/analyze', async (c) => {
  const id = cameraIdParam(c);
  const admin = isAdmin(c);
  if (!admin) {
    await requireCamera(c.env, id);
    const pref = await getPreferenceRow(c.env.DB, id);
    if (pref?.usefulness !== 'yes') throw new HttpError(403, 'not_watched', 'Only cameras marked useful can be analyzed without admin access.');
  }
  const force = admin && ['1', 'true'].includes(c.req.query('force') ?? '');
  return c.json(await analyzeCamera(c.env, c.executionCtx, id, { admin, force }));
});

cameraRoutes.get('/:id/history', async (c) => {
  const camera = await requireCamera(c.env, cameraIdParam(c));
  const limit = numberQuery(c, 'limit', 50, (n) => Number.isInteger(n) && n >= 1 && n <= 200, 'Must be a whole number from 1 to 200');
  return c.json(await detectionHistory(c.env.DB, camera.id, limit));
});

cameraRoutes.get('/:id/calibration', async (c) => {
  const camera = await requireCamera(c.env, cameraIdParam(c));
  const row = await getCalibrationRow(c.env.DB, camera.id);
  return c.json(row ? toCalibration(row) : null);
});

cameraRoutes.post('/:id/calibration', requireAdmin, async (c) => {
  const camera = await requireCamera(c.env, cameraIdParam(c));
  const body = parseOrThrow(calibrationBody, await readJson(c));
  const { home } = await readSettings(c.env);
  const farAnchors: ValidationDetail[] = body.regions.flatMap((r, i) =>
    r.anchor && haversineMiles(home, r.anchor) > MAX_ANCHOR_DISTANCE_MI
      ? [{ path: `regions.${i}.anchor`, message: `Must be within ${MAX_ANCHOR_DISTANCE_MI} miles of home` }]
      : [],
  );
  if (farAnchors.length) throw new HttpError(400, 'validation_failed', `${farAnchors[0]!.path}: ${farAnchors[0]!.message}`, farAnchors);
  const row = await upsertCalibration(c.env.DB, { cameraId: camera.id, ...body }, new Date().toISOString());
  return c.json(toCalibration(row));
});

cameraRoutes.delete('/:id/calibration', requireAdmin, async (c) => {
  await deleteCalibration(c.env.DB, cameraIdParam(c));
  return c.json({ ok: true });
});

cameraRoutes.post('/:id/usefulness', requireAdmin, async (c) => {
  const camera = await requireCamera(c.env, cameraIdParam(c));
  const body = parseOrThrow(usefulnessBody, await readJson(c));
  const existing = await getPreferenceRow(c.env.DB, camera.id);
  // Omitted fields keep their stored value; null or "" clears them.
  const keep = (value: string | null | undefined, stored: string | null | undefined) => (value === undefined ? (stored ?? null) : value || null);
  const row = await upsertPreference(
    c.env.DB,
    camera.id,
    { usefulness: body.usefulness, notes: keep(body.notes, existing?.notes), streetLabel: keep(body.streetLabel, existing?.street_label) },
    new Date().toISOString(),
  );
  return c.json(toPreference(row));
});
