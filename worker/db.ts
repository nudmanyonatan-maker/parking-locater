// Typed repository over D1. Every query is a prepared statement with bound
// parameters; multi-row writes go through batch() (one transaction).
// Row types mirror migrations/0001_init.sql; mappers turn rows into the
// shared API types.

import type { LaneStates } from '../shared/curb-gaps';
import type {
  Calibration,
  Camera,
  CameraPreference,
  DetectedObject,
  DetectionHistoryItem,
  Detection,
  Freshness,
  ParkingAnalysis,
  ParkingCandidate,
  ParkingStatus,
  Region,
  Usefulness,
} from '../shared/types';

// ---- rows -------------------------------------------------------------------

export interface CameraRow {
  id: string;
  name: string;
  area: string | null;
  latitude: number;
  longitude: number;
  is_online: number;
  distance_mi: number;
  synced_at: string;
}

export interface PreferenceRow {
  camera_id: string;
  usefulness: Usefulness;
  notes: string | null;
  street_label: string | null;
  updated_at: string;
}

export interface CalibrationRow {
  camera_id: string;
  regions_json: string;
  reference_width: number;
  reference_height: number;
  updated_at: string;
}

export interface FrameStateRow {
  camera_id: string;
  last_hash: string | null;
  last_fetched_at: string | null;
  last_changed_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  /** migrations/0003: EXIF capture time of the last frame. */
  last_capture_at: string | null;
}

export interface DetectionRow {
  id: number;
  camera_id: string;
  analyzed_at: string;
  frame_fetched_at: string | null;
  frame_hash: string | null;
  freshness: Freshness;
  status: ParkingStatus;
  vehicles_detected: number;
  parked_vehicles: number;
  candidate_spaces: number;
  confidence: number;
  detector: string;
  reason: string | null;
  objects_json: string | null;
  notes_json: string | null;
  error: string | null;
}

export interface CandidateRow {
  id: number;
  detection_id: number;
  camera_id: string;
  region_id: string | null;
  street_label: string;
  spaces: number;
  confidence: number;
  status: ParkingCandidate['status'];
  gap_start: number;
  gap_end: number;
  length_m: number | null;
  polygon_json: string;
  latitude: number;
  longitude: number;
  approximate_location: number;
  reasons_json: string | null;
  created_at: string;
}

export interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  enabled: number;
  created_at: string;
  last_notified_at: string | null;
  last_notified_key: string | null;
  failure_count: number;
  /** migrations/0006: recently alerted spots, JSON [{ key, at }] (see services/alerts.ts). */
  notified_spots_json: string | null;
}

export interface SettingRow {
  key: string;
  value_json: string;
}

// ---- mappers ----------------------------------------------------------------

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toCamera(row: CameraRow): Camera {
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    lat: row.latitude,
    lon: row.longitude,
    catalogOnline: row.is_online === 1,
    distanceMi: Number(row.distance_mi.toFixed(3)),
  };
}

export function toPreference(row: PreferenceRow | null | undefined): CameraPreference {
  if (!row) return { usefulness: 'unknown', notes: null, streetLabel: null, updatedAt: null };
  return { usefulness: row.usefulness, notes: row.notes, streetLabel: row.street_label, updatedAt: row.updated_at };
}

export function toCalibration(row: CalibrationRow): Calibration {
  const regions = parseJson<unknown>(row.regions_json, []);
  return {
    cameraId: row.camera_id,
    regions: Array.isArray(regions) ? (regions as Region[]) : [],
    referenceWidth: row.reference_width,
    referenceHeight: row.reference_height,
    updatedAt: row.updated_at,
  };
}

function toCandidate(row: CandidateRow): ParkingCandidate {
  return {
    id: row.id,
    cameraId: row.camera_id,
    regionId: row.region_id,
    streetLabel: row.street_label,
    spaces: row.spaces,
    confidence: row.confidence,
    status: row.status,
    gapStart: row.gap_start,
    gapEnd: row.gap_end,
    ...(row.length_m === null ? {} : { lengthM: row.length_m }),
    polygon: parseJson(row.polygon_json, []),
    lat: row.latitude,
    lon: row.longitude,
    approximateLocation: row.approximate_location === 1,
    reasons: parseJson(row.reasons_json, []),
  };
}

function toDetection(row: DetectionRow, candidates: CandidateRow[]): Detection {
  return {
    id: row.id,
    cameraId: row.camera_id,
    timestamp: row.analyzed_at,
    frameFetchedAt: row.frame_fetched_at,
    frameHash: row.frame_hash,
    freshness: row.freshness,
    detector: row.detector,
    vehiclesDetected: row.vehicles_detected,
    parkedVehicles: row.parked_vehicles,
    candidateSpaces: row.candidate_spaces,
    confidence: row.confidence,
    status: row.status,
    reason: row.reason,
    objects: parseJson<DetectedObject[]>(row.objects_json, []),
    candidates: candidates
      .filter((c) => c.detection_id === row.id)
      .map(toCandidate)
      .sort((a, b) => b.confidence - a.confidence),
    notes: parseJson<string[]>(row.notes_json, []),
    error: row.error,
  };
}

export function historyItemOf(d: Detection): DetectionHistoryItem {
  return {
    id: d.id,
    timestamp: d.timestamp,
    status: d.status,
    candidateSpaces: d.candidateSpaces,
    confidence: d.confidence,
    vehiclesDetected: d.vehiclesDetected,
    freshness: d.freshness,
    reason: d.reason,
  };
}

export function toHistoryItem(row: DetectionRow): DetectionHistoryItem {
  return {
    id: row.id,
    timestamp: row.analyzed_at,
    status: row.status,
    candidateSpaces: row.candidate_spaces,
    confidence: row.confidence,
    vehiclesDetected: row.vehicles_detected,
    freshness: row.freshness,
    reason: row.reason,
  };
}

// ---- settings ---------------------------------------------------------------

export async function getSettingRows(db: D1Database): Promise<SettingRow[]> {
  const { results } = await db.prepare('SELECT key, value_json FROM application_settings').all<SettingRow>();
  return results;
}

/** Upsert several settings in one transaction. Values are stored as JSON. */
export async function putSettings(db: D1Database, entries: [key: string, value: unknown][], now: string): Promise<void> {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO application_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  await db.batch(entries.map(([key, value]) => stmt.bind(key, JSON.stringify(value), now)));
}

// ---- cameras ----------------------------------------------------------------

export async function listCameraRows(db: D1Database, maxDistanceMi = Infinity): Promise<CameraRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM cameras WHERE distance_mi <= ? ORDER BY distance_mi, id')
    .bind(Number.isFinite(maxDistanceMi) ? maxDistanceMi : 1e9)
    .all<CameraRow>();
  return results;
}

export async function getCameraRow(db: D1Database, id: string): Promise<CameraRow | null> {
  return db.prepare('SELECT * FROM cameras WHERE id = ?').bind(id).first<CameraRow>();
}

export async function catalogStats(db: D1Database): Promise<{ count: number; lastSyncedAt: string | null }> {
  const row = await db.prepare('SELECT COUNT(*) AS count, MAX(synced_at) AS last FROM cameras').first<{ count: number; last: string | null }>();
  return { count: row?.count ?? 0, lastSyncedAt: row?.last ?? null };
}

/**
 * Replace the camera table with `cameras` (all stamped with `syncedAt`).
 * Rows not in the list are deleted; their preferences and calibrations stay,
 * so a camera that drops out of the catalog keeps its setup if it returns.
 */
export async function replaceCameras(db: D1Database, cameras: (Camera & { distanceMi: number })[], syncedAt: string): Promise<void> {
  const upsert = db.prepare(
    `INSERT INTO cameras (id, name, area, latitude, longitude, is_online, distance_mi, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, area = excluded.area, latitude = excluded.latitude,
       longitude = excluded.longitude, is_online = excluded.is_online, distance_mi = excluded.distance_mi,
       synced_at = excluded.synced_at`,
  );
  await db.batch([
    ...cameras.map((c) => upsert.bind(c.id, c.name, c.area, c.lat, c.lon, c.catalogOnline ? 1 : 0, c.distanceMi, syncedAt)),
    db.prepare('DELETE FROM cameras WHERE synced_at <> ?').bind(syncedAt),
  ]);
}

// ---- preferences ------------------------------------------------------------

export async function listPreferenceRows(db: D1Database): Promise<PreferenceRow[]> {
  const { results } = await db.prepare('SELECT * FROM camera_preferences').all<PreferenceRow>();
  return results;
}

export async function getPreferenceRow(db: D1Database, cameraId: string): Promise<PreferenceRow | null> {
  return db.prepare('SELECT * FROM camera_preferences WHERE camera_id = ?').bind(cameraId).first<PreferenceRow>();
}

export async function upsertPreference(
  db: D1Database,
  cameraId: string,
  pref: { usefulness: Usefulness; notes: string | null; streetLabel: string | null },
  now: string,
): Promise<PreferenceRow> {
  const row = await db
    .prepare(
      `INSERT INTO camera_preferences (camera_id, usefulness, notes, street_label, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (camera_id) DO UPDATE SET usefulness = excluded.usefulness, notes = excluded.notes,
         street_label = excluded.street_label, updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(cameraId, pref.usefulness, pref.notes, pref.streetLabel, now)
    .first<PreferenceRow>();
  if (!row) throw new Error('Preference upsert returned no row');
  return row;
}

// ---- calibrations -----------------------------------------------------------

export async function listCalibrationRows(db: D1Database): Promise<CalibrationRow[]> {
  const { results } = await db.prepare('SELECT * FROM camera_calibrations').all<CalibrationRow>();
  return results;
}

export async function getCalibrationRow(db: D1Database, cameraId: string): Promise<CalibrationRow | null> {
  return db.prepare('SELECT * FROM camera_calibrations WHERE camera_id = ?').bind(cameraId).first<CalibrationRow>();
}

export async function upsertCalibration(
  db: D1Database,
  cal: { cameraId: string; regions: Region[]; referenceWidth: number; referenceHeight: number },
  now: string,
): Promise<CalibrationRow> {
  const row = await db
    .prepare(
      `INSERT INTO camera_calibrations (camera_id, regions_json, reference_width, reference_height, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (camera_id) DO UPDATE SET regions_json = excluded.regions_json, reference_width = excluded.reference_width,
         reference_height = excluded.reference_height, updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(cal.cameraId, JSON.stringify(cal.regions), cal.referenceWidth, cal.referenceHeight, now)
    .first<CalibrationRow>();
  if (!row) throw new Error('Calibration upsert returned no row');
  return row;
}

export async function deleteCalibration(db: D1Database, cameraId: string): Promise<void> {
  await db.prepare('DELETE FROM camera_calibrations WHERE camera_id = ?').bind(cameraId).run();
}

// ---- frame state ------------------------------------------------------------

export async function listFrameStateRows(db: D1Database): Promise<FrameStateRow[]> {
  const { results } = await db.prepare('SELECT * FROM camera_frame_state').all<FrameStateRow>();
  return results;
}

export async function getFrameStateRow(db: D1Database, cameraId: string): Promise<FrameStateRow | null> {
  return db.prepare('SELECT * FROM camera_frame_state WHERE camera_id = ?').bind(cameraId).first<FrameStateRow>();
}

export interface StoredFrameState {
  lastHash: string | null;
  lastFetchedAt: string;
  lastChangedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastCaptureAt: string | null;
}

export async function putFrameState(db: D1Database, cameraId: string, s: StoredFrameState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO camera_frame_state (camera_id, last_hash, last_fetched_at, last_changed_at, consecutive_failures, last_error, last_capture_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (camera_id) DO UPDATE SET last_hash = excluded.last_hash, last_fetched_at = excluded.last_fetched_at,
         last_changed_at = excluded.last_changed_at, consecutive_failures = excluded.consecutive_failures,
         last_error = excluded.last_error, last_capture_at = excluded.last_capture_at`,
    )
    .bind(cameraId, s.lastHash, s.lastFetchedAt, s.lastChangedAt, s.consecutiveFailures, s.lastError, s.lastCaptureAt)
    .run();
}

// ---- analysis slots ---------------------------------------------------------

/**
 * Claim the right to analyze a camera now. Succeeds only when no analysis was
 * started after `cutoff` (now minus the cooldown). It is a single conditional
 * upsert, so of several concurrent callers (in any isolate) exactly one wins.
 */
export async function claimAnalysisSlot(db: D1Database, cameraId: string, now: string, cutoff: string): Promise<boolean> {
  const { meta } = await db
    .prepare(
      `INSERT INTO analysis_slots (camera_id, claimed_at) VALUES (?, ?)
       ON CONFLICT (camera_id) DO UPDATE SET claimed_at = excluded.claimed_at WHERE analysis_slots.claimed_at <= ?`,
    )
    .bind(cameraId, now, cutoff)
    .run();
  return meta.changes === 1;
}

// ---- detections -------------------------------------------------------------

/** Id of each stored camera's newest detection (uses idx_detections_camera_time). */
const LATEST_DETECTION_IDS = `SELECT (SELECT id FROM detections x WHERE x.camera_id = c.id ORDER BY x.analyzed_at DESC LIMIT 1) AS id FROM cameras c`;

/** Newest detection (with candidates) for every stored camera, keyed by camera id. */
/** Persisted curb occupancy grids for a camera (see shared/curb-gaps.ts). */
export async function getLaneState(db: D1Database, cameraId: string): Promise<LaneStates | undefined> {
  const row = await db.prepare('SELECT state_json FROM camera_lane_state WHERE camera_id = ?').bind(cameraId).first<{ state_json: string }>();
  if (!row) return undefined;
  try {
    return JSON.parse(row.state_json) as LaneStates;
  } catch {
    return undefined;
  }
}

export async function putLaneState(db: D1Database, cameraId: string, state: LaneStates, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO camera_lane_state (camera_id, state_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (camera_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    )
    .bind(cameraId, JSON.stringify(state), now)
    .run();
}

export async function latestDetections(db: D1Database): Promise<Map<string, Detection>> {
  const [detections, candidates] = await Promise.all([
    db.prepare(`SELECT * FROM detections WHERE id IN (${LATEST_DETECTION_IDS})`).all<DetectionRow>(),
    db.prepare(`SELECT * FROM parking_candidates WHERE detection_id IN (${LATEST_DETECTION_IDS})`).all<CandidateRow>(),
  ]);
  return new Map(detections.results.map((row) => [row.camera_id, toDetection(row, candidates.results)]));
}

/** The newest `limit` detections of one camera (newest first), with candidates. */
export async function recentDetections(db: D1Database, cameraId: string, limit: number): Promise<Detection[]> {
  const { results: rows } = await db
    .prepare('SELECT * FROM detections WHERE camera_id = ? ORDER BY analyzed_at DESC, id DESC LIMIT ?')
    .bind(cameraId, limit)
    .all<DetectionRow>();
  if (rows.length === 0) return [];
  const { results: candidates } = await db
    .prepare(`SELECT * FROM parking_candidates WHERE detection_id IN (${rows.map(() => '?').join(', ')})`)
    .bind(...rows.map((r) => r.id))
    .all<CandidateRow>();
  return rows.map((row) => toDetection(row, candidates));
}

export async function detectionHistory(db: D1Database, cameraId: string, limit: number): Promise<DetectionHistoryItem[]> {
  const { results } = await db
    .prepare(
      `SELECT id, camera_id, analyzed_at, status, candidate_spaces, confidence, vehicles_detected, freshness, reason
       FROM detections WHERE camera_id = ? ORDER BY analyzed_at DESC, id DESC LIMIT ?`,
    )
    .bind(cameraId, limit)
    .all<DetectionRow>();
  return results.map(toHistoryItem);
}

export async function lastDetectionAt(db: D1Database): Promise<string | null> {
  return db.prepare('SELECT MAX(analyzed_at) AS t FROM detections').first<string | null>('t');
}

/** Store an analysis and its candidates atomically; returns it with database ids. */
export async function insertDetection(db: D1Database, a: ParkingAnalysis): Promise<Detection> {
  const detection = db
    .prepare(
      `INSERT INTO detections (camera_id, analyzed_at, frame_fetched_at, frame_hash, freshness, status, vehicles_detected,
         parked_vehicles, candidate_spaces, confidence, detector, reason, objects_json, notes_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      a.cameraId,
      a.timestamp,
      a.frameFetchedAt,
      a.frameHash,
      a.freshness,
      a.status,
      a.vehiclesDetected,
      a.parkedVehicles,
      a.candidateSpaces,
      a.confidence,
      a.detector,
      a.reason,
      JSON.stringify(a.objects),
      JSON.stringify(a.notes),
      a.error,
    );
  // Inside the batch transaction the detection just inserted has the largest id.
  const candidate = db.prepare(
    `INSERT INTO parking_candidates (detection_id, camera_id, region_id, street_label, spaces, confidence, status, gap_start,
       gap_end, length_m, polygon_json, latitude, longitude, approximate_location, reasons_json, created_at)
     VALUES ((SELECT MAX(id) FROM detections), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const results = await db.batch<{ id: number }>([
    detection,
    ...a.candidates.map((c) =>
      candidate.bind(
        c.cameraId,
        c.regionId,
        c.streetLabel,
        c.spaces,
        c.confidence,
        c.status,
        c.gapStart,
        c.gapEnd,
        c.lengthM ?? null,
        JSON.stringify(c.polygon),
        c.lat,
        c.lon,
        c.approximateLocation ? 1 : 0,
        JSON.stringify(c.reasons),
        a.timestamp,
      ),
    ),
  ]);
  const id = results[0]?.results[0]?.id;
  if (typeof id !== 'number') throw new Error('Detection insert returned no id');
  return { ...a, id, candidates: a.candidates.map((c, i) => ({ ...c, id: results[i + 1]?.results[0]?.id })) };
}

/** Delete detections (and their candidates) analyzed before `cutoff`. Returns detections removed. */
export async function deleteDetectionsBefore(db: D1Database, cutoff: string): Promise<number> {
  const [, removed] = await db.batch([
    db.prepare('DELETE FROM parking_candidates WHERE detection_id IN (SELECT id FROM detections WHERE analyzed_at < ?)').bind(cutoff),
    db.prepare('DELETE FROM detections WHERE analyzed_at < ?').bind(cutoff),
  ]);
  return removed?.meta.changes ?? 0;
}

// ---- push subscriptions -----------------------------------------------------

export async function listEnabledSubscriptions(db: D1Database): Promise<SubscriptionRow[]> {
  const { results } = await db.prepare('SELECT * FROM notification_subscriptions WHERE enabled = 1 ORDER BY id').all<SubscriptionRow>();
  return results;
}

export async function countEnabledSubscriptions(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM notification_subscriptions WHERE enabled = 1').first<number>('n')) ?? 0;
}

/** Insert or refresh a subscription; re-subscribing re-enables it and clears failures. */
export async function upsertSubscription(db: D1Database, sub: { endpoint: string; p256dh: string; auth: string }, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notification_subscriptions (endpoint, p256dh, auth, enabled, created_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, enabled = 1, failure_count = 0`,
    )
    .bind(sub.endpoint, sub.p256dh, sub.auth, now)
    .run();
}

export async function deleteSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare('DELETE FROM notification_subscriptions WHERE endpoint = ?').bind(endpoint).run();
}

/** What a subscription's alert bookkeeping columns hold. */
export interface NotifiedState {
  at: string | null;
  key: string | null;
  spotsJson: string | null;
}

/**
 * Take a subscription's push slot before sending: succeeds only when nothing
 * was sent after `minIntervalCutoff` (now minus the minimum push interval).
 * One conditional UPDATE, so concurrent evaluations cannot both send.
 */
export async function claimNotification(db: D1Database, id: number, next: NotifiedState, minIntervalCutoff: string): Promise<boolean> {
  const { meta } = await db
    .prepare(
      `UPDATE notification_subscriptions SET last_notified_at = ?, last_notified_key = ?, notified_spots_json = ?
       WHERE id = ? AND (last_notified_at IS NULL OR last_notified_at <= ?)`,
    )
    .bind(next.at, next.key, next.spotsJson, id, minIntervalCutoff)
    .run();
  return meta.changes === 1;
}

/** Undo claimNotification after a failed delivery, unless something newer has replaced the claim. */
export async function releaseNotification(db: D1Database, id: number, claimed: NotifiedState, previous: NotifiedState): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_subscriptions SET last_notified_at = ?, last_notified_key = ?, notified_spots_json = ?
       WHERE id = ? AND last_notified_at IS ? AND last_notified_key IS ?`,
    )
    .bind(previous.at, previous.key, previous.spotsJson, id, claimed.at, claimed.key)
    .run();
}

export async function clearPushFailures(db: D1Database, id: number): Promise<void> {
  await db.prepare('UPDATE notification_subscriptions SET failure_count = 0 WHERE id = ?').bind(id).run();
}

export async function disableSubscription(db: D1Database, id: number): Promise<void> {
  await db.prepare('UPDATE notification_subscriptions SET enabled = 0 WHERE id = ?').bind(id).run();
}

/** Count a failed delivery; the subscription is disabled once failures reach `disableAt`. */
export async function recordPushFailure(db: D1Database, id: number, disableAt: number): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_subscriptions
       SET failure_count = failure_count + 1, enabled = CASE WHEN failure_count + 1 >= ? THEN 0 ELSE enabled END
       WHERE id = ?`,
    )
    .bind(disableAt, id)
    .run();
}
