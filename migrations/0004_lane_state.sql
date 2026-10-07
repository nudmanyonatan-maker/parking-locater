-- Per-camera curb occupancy grids (shared/curb-gaps.ts LaneStates JSON), so
-- evidence from successive checks is fused instead of judging single frames.
CREATE TABLE camera_lane_state (
  camera_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Estimated open curb length (m) of a candidate.
ALTER TABLE parking_candidates ADD COLUMN length_m REAL;
