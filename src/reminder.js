// Reminder logic for the "move your car" Discord ping.

const FIVE_MIN_MS = 5 * 60 * 1000;
const GRACE_MS = 2 * 60 * 1000;

// Pure predicate: should the cron fire the reminder right now?
// Fires inside the window from 5 min before moveBy until 2 min after,
// and only once (guarded by reminderSent).
export function shouldFireReminder(spot, now) {
  if (!spot) return false;
  if (spot.moveBy == null) return false;
  if (spot.reminderSent) return false;
  const delta = spot.moveBy - now; // ms until move-by time
  return delta <= FIVE_MIN_MS && delta > -GRACE_MS;
}

// Build the Discord webhook JSON body for a spot.
export function buildDiscordPayload(spot) {
  const when = new Date(spot.moveBy).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const mapLink = `https://maps.apple.com/?daddr=${spot.lat},${spot.lng}&dirflg=w`;
  const noteLine = spot.note ? `\nNote: ${spot.note}` : "";
  return {
    content: `🚗 Move your car by ${when} (within 5 min).${noteLine}\n📍 ${mapLink}`,
  };
}

// POST the reminder to Discord. Returns true on a 2xx response.
export async function sendDiscord(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok;
}
