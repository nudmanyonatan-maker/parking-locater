-- Spots each push subscription was alerted about recently: JSON array of
-- {"key": alertKey, "at": ISO time}, pruned to the 30-minute same-spot window.
-- last_notified_key only remembers the latest spot, so two spots that stay
-- open used to alternate (A, B, A, ...) every 5 minutes.
ALTER TABLE notification_subscriptions ADD COLUMN notified_spots_json TEXT;
