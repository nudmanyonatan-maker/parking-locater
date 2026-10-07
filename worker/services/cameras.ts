// Camera catalog (synced from TMC, limited to CATALOG_RADIUS_MI around home)
// and the read models built on it: CameraSummary and CameraDetail.

import { secondsSince } from '../../shared/freshness';
import { withinRadius } from '../../shared/geo';
import { CATALOG_RADIUS_MI, FALLBACK_HOME, HOME_ADDRESS } from '../../shared/settings';
import type { Calibration, Camera, CameraDetail, CameraSummary, Detection, HomeLocation } from '../../shared/types';
import {
  catalogStats,
  getCalibrationRow,
  getCameraRow,
  getFrameStateRow,
  getPreferenceRow,
  latestDetections,
  listCalibrationRows,
  listCameraRows,
  listFrameStateRows,
  listPreferenceRows,
  recentDetections,
  replaceCameras,
  toCalibration,
  toCamera,
  historyItemOf,
  toPreference,
  type CalibrationRow,
  type CameraRow,
  type FrameStateRow,
  type PreferenceRow,
} from '../db';
import type { Env } from '../env';
import { geocodeHome } from '../geocode';
import { errorMessage, HttpError } from '../http';
import { fetchCatalog } from '../tmc';
import { frameStateFromRow } from './frames';
import { readSettingsState, saveHome } from './settings';

const CATALOG_MAX_AGE_MS = 12 * 3600_000;
/** Automatic syncs are attempted at most this often (per database binding, per isolate). */
const SYNC_RETRY_DELAY_MS = 60_000;
const lastSyncAttempt = new WeakMap<D1Database, number>();

const isFallbackHome = (home: HomeLocation) => home.source.startsWith('fallback');

/**
 * Home coordinates: the stored value, else geocode once and store it. If every
 * geocoder fails, FALLBACK_HOME is stored with source "fallback", which makes
 * the next catalog sync try geocoding again.
 */
export async function getHome(env: Env): Promise<HomeLocation> {
  const { storedHome } = await readSettingsState(env);
  if (storedHome && !isFallbackHome(storedHome)) return storedHome;
  const geocoded = await geocodeHome(storedHome?.address ?? HOME_ADDRESS);
  if (geocoded) {
    await saveHome(env, geocoded);
    return geocoded;
  }
  if (storedHome) return storedHome;
  const fallback: HomeLocation = { ...FALLBACK_HOME, source: 'fallback' };
  await saveHome(env, fallback);
  return fallback;
}

/** Fetch the TMC catalog and store the cameras near home. Returns how many were stored. */
export async function syncCatalog(env: Env): Promise<number> {
  const [home, catalog] = await Promise.all([getHome(env), fetchCatalog(env)]);
  const nearby: Camera[] = withinRadius(catalog, home, CATALOG_RADIUS_MI).map((c) => ({
    id: c.id,
    name: c.name,
    area: c.area,
    lat: c.lat,
    lon: c.lon,
    catalogOnline: c.isOnline,
    distanceMi: c.distanceMi,
  }));
  await replaceCameras(env.DB, nearby, new Date().toISOString());
  console.log(`catalog: stored ${nearby.length} of ${catalog.length} cameras within ${CATALOG_RADIUS_MI} mi (home via ${home.source})`);
  return nearby.length;
}

/** Sync when the table is empty or older than 12 h. Never throws: pages still load from what is stored. */
export async function ensureCatalogFresh(env: Env): Promise<void> {
  const { count, lastSyncedAt } = await catalogStats(env.DB);
  const age = lastSyncedAt ? Date.now() - Date.parse(lastSyncedAt) : Infinity;
  if (count > 0 && age < CATALOG_MAX_AGE_MS) return;
  const attemptedAt = lastSyncAttempt.get(env.DB);
  if (attemptedAt !== undefined && Date.now() - attemptedAt < SYNC_RETRY_DELAY_MS) return;
  lastSyncAttempt.set(env.DB, Date.now());
  try {
    await syncCatalog(env);
  } catch (e) {
    console.error(`catalog: automatic sync failed: ${errorMessage(e)}`);
  }
}

export function hasParkingLane(calibration: Pick<Calibration, 'regions'> | null): boolean {
  return !!calibration?.regions.some((r) => r.kind === 'parking');
}

function buildSummary(
  row: CameraRow,
  pref: PreferenceRow | null | undefined,
  calibration: CalibrationRow | null | undefined,
  frame: FrameStateRow | null | undefined,
  latest: Detection | null,
  now: Date,
): CameraSummary {
  const camera = toCamera(row);
  return {
    ...camera,
    preference: toPreference(pref),
    calibrated: calibration ? hasParkingLane(toCalibration(calibration)) : false,
    frame: frameStateFromRow(frame, camera.catalogOnline, now),
    latest,
    latestAgeSeconds: latest ? secondsSince(latest.timestamp, now) : null,
  };
}

const byCameraId = <T extends { camera_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.camera_id, r]));

/** Every stored camera (optionally only those within `radiusMi` of home), nearest first. */
export async function cameraSummaries(env: Env, opts: { radiusMi?: number } = {}): Promise<CameraSummary[]> {
  const db = env.DB;
  const [cameras, prefs, calibrations, frames, latest] = await Promise.all([
    listCameraRows(db, opts.radiusMi),
    listPreferenceRows(db),
    listCalibrationRows(db),
    listFrameStateRows(db),
    latestDetections(db),
  ]);
  const prefById = byCameraId(prefs);
  const calById = byCameraId(calibrations);
  const frameById = byCameraId(frames);
  const now = new Date();
  return cameras.map((row) =>
    buildSummary(row, prefById.get(row.id), calById.get(row.id), frameById.get(row.id), latest.get(row.id) ?? null, now),
  );
}

/** Cameras marked useful, calibrated with a parking lane, within `radiusMi`; nearest first. */
export async function watchedCalibratedCameras(env: Env, radiusMi: number): Promise<Camera[]> {
  const [cameras, prefs, calibrations] = await Promise.all([listCameraRows(env.DB, radiusMi), listPreferenceRows(env.DB), listCalibrationRows(env.DB)]);
  const watched = new Set(prefs.filter((p) => p.usefulness === 'yes').map((p) => p.camera_id));
  const calibrated = new Set(calibrations.filter((c) => hasParkingLane(toCalibration(c))).map((c) => c.camera_id));
  return cameras.filter((c) => watched.has(c.id) && calibrated.has(c.id)).map(toCamera);
}

export async function requireCamera(env: Env, id: string): Promise<Camera> {
  const row = await getCameraRow(env.DB, id);
  if (!row) throw new HttpError(404, 'camera_not_found', `No camera "${id}" near home. Sync the catalog if it is new.`);
  return toCamera(row);
}

export async function cameraDetail(env: Env, id: string): Promise<CameraDetail> {
  const db = env.DB;
  const row = await getCameraRow(db, id);
  if (!row) throw new HttpError(404, 'camera_not_found', `No camera "${id}" near home. Sync the catalog if it is new.`);
  const [pref, calibration, frame, recent] = await Promise.all([
    getPreferenceRow(db, id),
    getCalibrationRow(db, id),
    getFrameStateRow(db, id),
    recentDetections(db, id, 2),
  ]);
  const summary = buildSummary(row, pref, calibration, frame, recent[0] ?? null, new Date());
  const previous = recent[1];
  return {
    ...summary,
    calibration: calibration ? toCalibration(calibration) : null,
    previous: previous ? historyItemOf(previous) : null,
    imageUrl: `/api/cameras/${encodeURIComponent(id)}/image`,
  };
}
