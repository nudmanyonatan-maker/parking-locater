-- EXIF capture time of the last frame (UTC ISO), for cameras that write one.
-- Lets STALE detection catch cameras that resend an old picture whose bytes
-- still change (see FRESHNESS.exifStaleAfterSeconds in shared/freshness.ts).
-- Numbered 0003 because 0002 is reserved for the seed calibration.
ALTER TABLE camera_frame_state ADD COLUMN last_capture_at TEXT;
