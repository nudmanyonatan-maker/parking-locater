-- ParkNearMe schema. Timestamps are ISO-8601 UTC strings.

-- Cameras near home, synced from the NYC TMC catalog.
CREATE TABLE cameras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  is_online INTEGER NOT NULL DEFAULT 1,
  distance_mi REAL NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_cameras_distance ON cameras (distance_mi);

-- Manual "useful for parking?" judgement and labels.
CREATE TABLE camera_preferences (
  camera_id TEXT PRIMARY KEY,
  usefulness TEXT NOT NULL DEFAULT 'unknown' CHECK (usefulness IN ('yes', 'no', 'unknown')),
  notes TEXT,
  street_label TEXT,
  updated_at TEXT NOT NULL
);

-- Calibration polygons (JSON array of Region, see shared/types.ts).
CREATE TABLE camera_calibrations (
  camera_id TEXT PRIMARY KEY,
  regions_json TEXT NOT NULL,
  reference_width INTEGER NOT NULL DEFAULT 352,
  reference_height INTEGER NOT NULL DEFAULT 240,
  updated_at TEXT NOT NULL
);

-- Last frame seen per camera, for LIVE / STALE / OFFLINE.
CREATE TABLE camera_frame_state (
  camera_id TEXT PRIMARY KEY,
  last_hash TEXT,
  last_fetched_at TEXT,
  last_changed_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- One row per analysis run.
CREATE TABLE detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  frame_fetched_at TEXT,
  frame_hash TEXT,
  freshness TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('likely_available', 'possible', 'none', 'unknown')),
  vehicles_detected INTEGER NOT NULL DEFAULT 0,
  parked_vehicles INTEGER NOT NULL DEFAULT 0,
  candidate_spaces INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  detector TEXT NOT NULL,
  reason TEXT,
  objects_json TEXT,
  notes_json TEXT,
  error TEXT
);
CREATE INDEX idx_detections_camera_time ON detections (camera_id, analyzed_at DESC);
CREATE INDEX idx_detections_time ON detections (analyzed_at);

-- Candidate openings found by a detection.
CREATE TABLE parking_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  detection_id INTEGER NOT NULL REFERENCES detections (id) ON DELETE CASCADE,
  camera_id TEXT NOT NULL,
  region_id TEXT,
  street_label TEXT NOT NULL,
  spaces INTEGER NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  gap_start REAL NOT NULL,
  gap_end REAL NOT NULL,
  polygon_json TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  approximate_location INTEGER NOT NULL DEFAULT 1,
  reasons_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_candidates_detection ON parking_candidates (detection_id);

-- Web Push subscriptions (one per browser/device).
CREATE TABLE notification_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_notified_at TEXT,
  last_notified_key TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);

-- Key/value settings (JSON values). See shared/settings.ts for keys and defaults.
CREATE TABLE application_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
