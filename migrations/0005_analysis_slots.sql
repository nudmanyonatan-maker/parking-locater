-- When each camera's latest analysis started. analyzeCamera claims the slot
-- with one conditional upsert BEFORE it fetches a frame or calls Workers AI,
-- so concurrent requests (in any isolate) cannot all pass the cooldown and
-- each pay for their own analysis. See claimAnalysisSlot in worker/db.ts.
CREATE TABLE analysis_slots (
  camera_id TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL
);
