# Parking Locator — Design Spec

**Date:** 2026-06-05
**Author:** Yonatan (with Claude)
**Status:** Approved design, pre-implementation

## Problem

Yonatan parks his car around Washington Heights (~184th & Audubon, near Yeshiva
University) and forgets where it is by the time he goes back. The Ford app's GPS
locator is unreliable. He needs a dead-simple, phone-first tool to:

1. **Quickly drop a pin** on where he parked.
2. **Quickly find the car** again (map + walking directions).
3. **Note a "move by" time** (e.g. street-cleaning / alternate-side parking) and
   get pinged **5 minutes before** that time via a **Discord webhook**.

Primary device: **iPhone**. Almost always used on mobile.

## Goals

- One screen, two states, minimal taps.
- Reliable proactive reminder that fires even when the phone is asleep.
- Hosted on Cloudflare, one deploy, low maintenance.

## Non-Goals (YAGNI)

- No login / accounts / multi-user (single user; no auth — explicitly out of scope
  per user decision).
- No parking history (one active spot at a time; saving a new spot overwrites).
- No Google Maps option (Apple Maps only — user is on iPhone).
- No native app, no push-notification plumbing.

## Architecture

A **single Cloudflare Worker** does everything:

| Responsibility | Mechanism |
|---|---|
| Serve the web UI | Workers **Static Assets** (`/public` dir) |
| Read/write the current spot | `fetch` handler → `/api/spot` → **KV** namespace |
| Fire the reminder | **Cron Trigger** (every minute) → `scheduled` handler → Discord webhook |

**Why one Worker:** cloud sync + a server-side timed reminder both require a
backend. A Worker with Static Assets + KV + Cron collapses all three needs into a
single deployable unit. (Rejected alternative: Pages + Functions + separate cron
Worker — more moving parts, no benefit for a solo app.)

**Map:** Leaflet + OpenStreetMap raster tiles (free, no API key).

**Secrets:** The Discord webhook URL is stored as an encrypted **Cloudflare
secret** (`DISCORD_WEBHOOK_URL`), never committed to the repo. Locally it lives in
`.dev.vars` (gitignored).

## Data Model

One KV key, `spot`, holding JSON (or absent when no car is parked):

```jsonc
{
  "lat": 40.8506,
  "lng": -73.9300,
  "note": "Audubon side, near the hydrant",   // string, may be ""
  "moveBy": 1749200400000,                      // epoch ms (UTC), or null
  "createdAt": 1749150000000,                   // epoch ms
  "reminderSent": false                         // true once Discord fired
}
```

Times are stored as **absolute epoch milliseconds** to avoid timezone bugs. The
browser converts the `datetime-local` picker value to epoch on save; the UI
renders it back in the phone's local time.

## API

| Method | Path | Body | Behavior |
|---|---|---|---|
| `GET` | `/api/spot` | — | Returns the spot JSON, or `204`/`null` if none. |
| `PUT` | `/api/spot` | `{lat,lng,note,moveBy}` | Saves spot; sets `createdAt`, resets `reminderSent=false`. |
| `DELETE` | `/api/spot` | — | Clears the spot ("Got my car"). |

Responses are JSON; errors return a non-2xx with a short JSON message (no silent
failures).

## UI — One Screen, Two States

### State A — No spot saved ("I parked here")
- Large primary button: **📍 I parked here** → requests geolocation, drops a
  draggable pin on the map centered on the reading.
- **Drag the pin** to correct GPS drift (important near tall buildings by YU).
- Optional **note** text field.
- Optional **"move by"** `datetime-local` picker.
- **Save** button → `PUT /api/spot`.

### State B — Spot saved ("Find my car")
- Map centered on the car pin, with the user's live location marker and a
  computed **distance** ("0.2 mi away").
- **🧭 Walk to my car** → Apple Maps walking deep link:
  `https://maps.apple.com/?daddr=<lat>,<lng>&dirflg=w`
- **Note** and **move-by time** shown prominently; the move-by turns **red** when
  within ~30 min, and shows "overdue" styling if passed.
- **✓ Got my car** button → `DELETE /api/spot` → returns to State A.

The app is a small **PWA** (manifest + apple-touch-icon) so it can be added to the
home screen and open full-screen like a native app.

## The Reminder (Cron)

- `wrangler.jsonc` registers a cron trigger `"* * * * *"` (every minute).
- `scheduled` handler:
  1. Read `spot` from KV. If absent, or `moveBy` is null, or `reminderSent` is
     true → do nothing.
  2. If `moveBy - now <= 5 min` **and** `moveBy - now > -<grace>` (still relevant)
     → POST to `DISCORD_WEBHOOK_URL`.
  3. Set `reminderSent = true` and write back to KV (fire once).
- **Discord message:** car emoji + "Move your car by `<local time>`", the note,
  and an Apple Maps link to the spot.

Edge handling: if the Worker missed the exact 5-min mark (e.g. the spot was saved
with a move-by already inside the window), the next minute's run still catches it
because the condition is a window (`<= 5 min`), not an exact equality.

## Error Handling

- Geolocation denied/unavailable → inline message with a retry; user can still
  place the pin manually by tapping/dragging on the map.
- API/network failure on save → surfaced to the user (button shows error state),
  not swallowed.
- Cron Discord POST failure → logged via `console`/observability; `reminderSent`
  is only set to `true` on a successful POST so a transient failure retries next
  minute.

## Testing

- **Unit:** the reminder-window predicate (given `moveBy`, `now`, `reminderSent`
  → should-fire boolean) — the one piece of real logic. Pure function, easy to
  test with Vitest.
- **Manual:** deploy, park a pin, set a move-by ~6 min out, confirm Discord pings
  at the 5-min mark; confirm "Walk to my car" opens Apple Maps; confirm "Got my
  car" clears state.

## Deployment

- `wrangler deploy` (single Worker). Bindings: KV namespace, assets dir, cron
  trigger. Secret set via `wrangler secret put DISCORD_WEBHOOK_URL`.
- Cloudflare creds are already in the shell env, so no auth step needed.

## Open Questions

None — design approved by user (no PIN/auth; Apple Maps only).
