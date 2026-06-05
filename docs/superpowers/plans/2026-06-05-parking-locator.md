# Parking Locator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-first web app to drop a pin where you parked, navigate back to it, and get a Discord ping 5 minutes before a "move by" time.

**Architecture:** A single Cloudflare Worker serves a static mobile UI (Leaflet map), stores one parking spot in KV via a small JSON API, and runs a per-minute Cron Trigger that fires a Discord webhook when the move-by time is near.

**Tech Stack:** Cloudflare Workers (Static Assets + KV + Cron), Wrangler 4, vanilla JS + Leaflet 1.9.4 (CDN) + OpenStreetMap tiles, Vitest for the one pure unit.

---

## File Structure

```
parking-locator/
├── package.json                 # scripts + dev deps (wrangler, vitest)
├── wrangler.jsonc               # worker config: main, assets, KV, cron
├── .gitignore
├── .dev.vars.example            # template for the webhook secret
├── .dev.vars                    # real secret for local dev (gitignored, created in Task 7)
├── vitest.config.js             # plain node test config
├── src/
│   ├── index.js                 # worker entry: fetch (API + asset fallback) + scheduled (cron)
│   ├── spot.js                  # KV helpers: getSpot / putSpot / deleteSpot
│   └── reminder.js              # shouldFireReminder() + buildDiscordPayload() + sendDiscord()
├── public/
│   ├── index.html               # the one screen (two states)
│   ├── styles.css               # mobile-first styles
│   ├── app.js                   # geolocation, map, save/clear, distance, Apple Maps link
│   ├── manifest.webmanifest     # PWA manifest (add-to-home-screen)
│   ├── icon.svg                 # app icon (cosmetic)
│   └── vendor/leaflet/          # self-hosted Leaflet (leaflet.js, leaflet.css, images/)
└── test/
    └── reminder.test.js         # unit tests for shouldFireReminder
```

**Responsibilities:**
- `src/reminder.js` — all reminder decisions and Discord formatting. Pure logic + one network call, isolated so it's unit-testable.
- `src/spot.js` — the only place that knows the KV key and shape on disk.
- `src/index.js` — HTTP routing and cron orchestration only; delegates to the two modules above.
- `public/app.js` — all browser behavior; talks to the Worker only through `/api/spot`.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `wrangler.jsonc`
- Create: `vitest.config.js`
- Create: `.gitignore`
- Create: `.dev.vars.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "parking-locator",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.9",
    "wrangler": "^4.20.0"
  }
}
```

- [ ] **Step 2: Create `wrangler.jsonc`**

The `id` is a placeholder filled in during Task 7 (`<KV_NAMESPACE_ID>`). Everything else is final.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "parking-locator",
  "main": "src/index.js",
  "compatibility_date": "2025-06-01",
  "assets": {
    "directory": "./public"
  },
  "kv_namespaces": [
    { "binding": "PARKING_KV", "id": "<KV_NAMESPACE_ID>" }
  ],
  "triggers": {
    "crons": ["* * * * *"]
  },
  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 3: Create `vitest.config.js`**

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
.dev.vars
.wrangler/
dist/
.DS_Store
```

- [ ] **Step 5: Create `.dev.vars.example`**

```
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/your-id/your-token"
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc vitest.config.js .gitignore .dev.vars.example
git commit -m "chore: scaffold cloudflare worker project"
```

---

## Task 2: Reminder logic (TDD)

**Files:**
- Test: `test/reminder.test.js`
- Create: `src/reminder.js`

- [ ] **Step 1: Write the failing test**

Create `test/reminder.test.js`:

```js
import { describe, it, expect } from "vitest";
import { shouldFireReminder } from "../src/reminder.js";

const base = { lat: 40.85, lng: -73.93, note: "", createdAt: 0, reminderSent: false };
const MIN = 60 * 1000;

describe("shouldFireReminder", () => {
  it("is false when there is no spot", () => {
    expect(shouldFireReminder(null, 0)).toBe(false);
  });

  it("is false when moveBy is null", () => {
    expect(shouldFireReminder({ ...base, moveBy: null }, 0)).toBe(false);
  });

  it("is false when more than 5 minutes remain", () => {
    expect(shouldFireReminder({ ...base, moveBy: 6 * MIN }, 0)).toBe(false);
  });

  it("is true at exactly 5 minutes out", () => {
    expect(shouldFireReminder({ ...base, moveBy: 5 * MIN }, 0)).toBe(true);
  });

  it("is true just before the move-by time", () => {
    expect(shouldFireReminder({ ...base, moveBy: 1 * MIN }, 0)).toBe(true);
  });

  it("is true within the 2-minute grace after move-by", () => {
    expect(shouldFireReminder({ ...base, moveBy: -1 * MIN }, 0)).toBe(true);
  });

  it("is false once the grace window has passed", () => {
    expect(shouldFireReminder({ ...base, moveBy: -3 * MIN }, 0)).toBe(false);
  });

  it("is false when the reminder was already sent", () => {
    expect(shouldFireReminder({ ...base, moveBy: 1 * MIN, reminderSent: true }, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "../src/reminder.js"` (file does not exist yet).

- [ ] **Step 3: Implement `src/reminder.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 8 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/reminder.js test/reminder.test.js
git commit -m "feat: reminder window predicate and discord payload (TDD)"
```

---

## Task 3: KV storage helpers

**Files:**
- Create: `src/spot.js`

- [ ] **Step 1: Implement `src/spot.js`**

```js
// KV-backed storage for the single current parking spot.
// One key, "spot", holds the spot JSON (absent when no car is parked).

const SPOT_KEY = "spot";

export async function getSpot(env) {
  return await env.PARKING_KV.get(SPOT_KEY, "json");
}

export async function putSpot(env, spot) {
  await env.PARKING_KV.put(SPOT_KEY, JSON.stringify(spot));
}

export async function deleteSpot(env) {
  await env.PARKING_KV.delete(SPOT_KEY);
}
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check src/spot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/spot.js
git commit -m "feat: KV helpers for the parking spot"
```

---

## Task 4: Worker entry (API + cron)

**Files:**
- Create: `src/index.js`

- [ ] **Step 1: Implement `src/index.js`**

```js
import { getSpot, putSpot, deleteSpot } from "./spot.js";
import { shouldFireReminder, buildDiscordPayload, sendDiscord } from "./reminder.js";

const json = (data, status = 200) =>
  new Response(data === null ? "null" : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handleApi(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/api/spot") return json({ error: "not found" }, 404);

  if (request.method === "GET") {
    return json(await getSpot(env));
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json({ error: "lat and lng are required numbers" }, 400);
    }
    const spot = {
      lat,
      lng,
      note: typeof body.note === "string" ? body.note : "",
      moveBy: body.moveBy == null ? null : Number(body.moveBy),
      createdAt: Date.now(),
      reminderSent: false,
    };
    await putSpot(env, spot);
    return json(spot);
  }

  if (request.method === "DELETE") {
    await deleteSpot(env);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

async function runReminderCheck(env) {
  const spot = await getSpot(env);
  if (!shouldFireReminder(spot, Date.now())) return;
  if (!env.DISCORD_WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL not configured");
    return;
  }
  const ok = await sendDiscord(env.DISCORD_WEBHOOK_URL, buildDiscordPayload(spot));
  if (ok) {
    await putSpot(env, { ...spot, reminderSent: true });
  } else {
    console.error("Discord webhook POST failed; will retry next run");
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    // Requests that didn't match a static asset and aren't API calls.
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderCheck(env));
  },
};
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check src/index.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the Worker boots locally**

Run (background it, then stop after the check): `npx wrangler dev --port 8787`
Then in another shell: `curl -s -X PUT http://localhost:8787/api/spot -H 'Content-Type: application/json' -d '{"lat":40.85,"lng":-73.93,"note":"test","moveBy":null}'`
Expected: JSON echoing the spot with `"createdAt"` and `"reminderSent":false`.
Then: `curl -s http://localhost:8787/api/spot`
Expected: the same spot JSON.
Then: `curl -s -X DELETE http://localhost:8787/api/spot` → `{"ok":true}`, and a follow-up GET returns `null`.
Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: worker fetch API and scheduled reminder handler"
```

---

## Task 5: Frontend shell (HTML, CSS, manifest, icon)

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/manifest.webmanifest`
- Create: `public/icon.svg`
- Create: `public/vendor/leaflet/` (downloaded library, not hand-written)

- [ ] **Step 0: Vendor Leaflet locally (self-hosted, no CDN)**

Download the pinned Leaflet 1.9.4 files so no third-party executable code is loaded at runtime. The `images/` folder must sit next to `leaflet.css` — Leaflet derives its marker-icon paths from the CSS location automatically.

```bash
mkdir -p public/vendor/leaflet/images
BASE=https://unpkg.com/leaflet@1.9.4/dist
curl -fsSL "$BASE/leaflet.js"  -o public/vendor/leaflet/leaflet.js
curl -fsSL "$BASE/leaflet.css" -o public/vendor/leaflet/leaflet.css
for img in marker-icon marker-icon-2x marker-shadow layers layers-2x; do
  curl -fsSL "$BASE/images/$img.png" -o "public/vendor/leaflet/images/$img.png"
done
```

Verify the files downloaded (non-zero sizes, 7 files total):

Run: `ls -la public/vendor/leaflet public/vendor/leaflet/images`
Expected: `leaflet.js` (~140KB), `leaflet.css` (~14KB), and five PNGs under `images/`.

- [ ] **Step 1: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <title>Where's My Car</title>
  <meta name="theme-color" content="#0b3d2e" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/icon.svg" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="map"></div>

  <div class="panel">
    <!-- State A: no spot saved -->
    <section id="park-view" class="view">
      <button id="park-btn" class="btn btn-primary btn-big">📍 I parked here</button>
      <div id="park-form" class="hidden">
        <label class="field">
          <span>Note (optional)</span>
          <input id="note-input" type="text" placeholder="e.g. Audubon side, by the hydrant" />
        </label>
        <label class="field">
          <span>Move by (optional)</span>
          <input id="moveby-input" type="datetime-local" />
        </label>
        <button id="save-btn" class="btn btn-primary">Save spot</button>
        <p class="hint">Drag the pin to fix the exact spot.</p>
      </div>
    </section>

    <!-- State B: spot saved -->
    <section id="find-view" class="view hidden">
      <div id="distance" class="distance"></div>
      <div id="moveby-banner" class="banner hidden"></div>
      <div id="note-display" class="note hidden"></div>
      <a id="walk-btn" class="btn btn-primary btn-big" href="#">🧭 Walk to my car</a>
      <button id="clear-btn" class="btn btn-secondary">✓ Got my car</button>
    </section>

    <div id="error" class="error hidden"></div>
  </div>

  <script src="/vendor/leaflet/leaflet.js"></script>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/styles.css`**

```css
:root {
  --accent: #16a34a;
  --danger: #dc2626;
  --card: #ffffff;
  --card-text: #0f172a;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  height: 100%;
  font-family: -apple-system, system-ui, sans-serif;
}

#map {
  position: fixed;
  inset: 0;
  z-index: 0;
}

.panel {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  padding: 16px;
  padding-bottom: calc(16px + env(safe-area-inset-bottom));
  background: var(--card);
  color: var(--card-text);
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.view { display: flex; flex-direction: column; gap: 12px; }
.hidden { display: none !important; }

.btn {
  border: none;
  border-radius: 14px;
  padding: 16px;
  font-size: 18px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  text-decoration: none;
  display: block;
}
.btn-big { font-size: 20px; padding: 20px; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-secondary { background: #e2e8f0; color: var(--card-text); }

.field { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
.field input {
  padding: 14px;
  font-size: 16px; /* >=16px stops iOS from zooming in on focus */
  border: 1px solid #cbd5e1;
  border-radius: 12px;
}

.hint { margin: 0; font-size: 13px; color: #64748b; text-align: center; }
.distance { font-size: 22px; font-weight: 700; text-align: center; }

.banner {
  padding: 12px;
  border-radius: 12px;
  font-weight: 600;
  text-align: center;
  background: #fef9c3;
  color: #854d0e;
}
.banner.urgent { background: #fee2e2; color: var(--danger); }

.note {
  padding: 12px;
  border-radius: 12px;
  background: #f1f5f9;
  text-align: center;
}

.error {
  padding: 12px;
  border-radius: 12px;
  background: #fee2e2;
  color: var(--danger);
  text-align: center;
}
```

- [ ] **Step 3: Create `public/manifest.webmanifest`**

```json
{
  "name": "Where's My Car",
  "short_name": "My Car",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0b3d2e",
  "theme_color": "#0b3d2e",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
  ]
}
```

- [ ] **Step 4: Create `public/icon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0b3d2e"/>
  <text x="50%" y="52%" font-size="300" text-anchor="middle" dominant-baseline="central">🚗</text>
</svg>
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/styles.css public/manifest.webmanifest public/icon.svg public/vendor
git commit -m "feat: mobile-first frontend shell, PWA manifest, vendored Leaflet"
```

---

## Task 6: Frontend behavior (app.js)

**Files:**
- Create: `public/app.js`

- [ ] **Step 1: Implement `public/app.js`**

```js
/* global L */
const HOME = [40.8506, -73.9300]; // 184th & Audubon fallback center

const els = {
  parkView: document.getElementById("park-view"),
  findView: document.getElementById("find-view"),
  parkBtn: document.getElementById("park-btn"),
  parkForm: document.getElementById("park-form"),
  noteInput: document.getElementById("note-input"),
  movebyInput: document.getElementById("moveby-input"),
  saveBtn: document.getElementById("save-btn"),
  distance: document.getElementById("distance"),
  movebyBanner: document.getElementById("moveby-banner"),
  noteDisplay: document.getElementById("note-display"),
  walkBtn: document.getElementById("walk-btn"),
  clearBtn: document.getElementById("clear-btn"),
  error: document.getElementById("error"),
};

const map = L.map("map", { zoomControl: false }).setView(HOME, 16);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap",
  maxZoom: 19,
}).addTo(map);

let carMarker = null; // the parked-car pin
let meMarker = null;  // user's live location dot
let pending = null;   // {lat,lng} being placed before save
let watchId = null;   // geolocation watch handle

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
}
function clearError() {
  els.error.classList.add("hidden");
}

function setCarMarker(lat, lng, draggable) {
  if (carMarker) map.removeLayer(carMarker);
  carMarker = L.marker([lat, lng], { draggable }).addTo(map);
  if (draggable) {
    carMarker.on("dragend", () => {
      const p = carMarker.getLatLng();
      pending = { lat: p.lat, lng: p.lng };
    });
  }
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  const feet = m * 3.28084;
  if (feet < 1000) return `${Math.round(feet)} ft away`;
  return `${(m / 1609.34).toFixed(1)} mi away`;
}

// ---- State A: parking ----
els.parkBtn.addEventListener("click", () => {
  clearError();
  els.parkBtn.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      pending = { lat: latitude, lng: longitude };
      map.setView([latitude, longitude], 18);
      setCarMarker(latitude, longitude, true);
      els.parkBtn.classList.add("hidden");
      els.parkForm.classList.remove("hidden");
    },
    () => {
      // GPS denied/unavailable: drop a draggable pin they can position by hand.
      showError("Couldn't get GPS — drag the pin to where you parked.");
      pending = { lat: HOME[0], lng: HOME[1] };
      map.setView(HOME, 17);
      setCarMarker(HOME[0], HOME[1], true);
      els.parkBtn.classList.add("hidden");
      els.parkForm.classList.remove("hidden");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

els.saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  clearError();
  els.saveBtn.textContent = "Saving…";
  const moveBy = els.movebyInput.value
    ? new Date(els.movebyInput.value).getTime()
    : null;
  try {
    const res = await fetch("/api/spot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: pending.lat,
        lng: pending.lng,
        note: els.noteInput.value.trim(),
        moveBy,
      }),
    });
    if (!res.ok) throw new Error("save failed");
    const spot = await res.json();
    renderFindView(spot);
  } catch (err) {
    els.saveBtn.textContent = "Save spot";
    showError("Couldn't save. Check your connection and try again.");
  }
});

// ---- State B: find ----
els.clearBtn.addEventListener("click", async () => {
  clearError();
  try {
    await fetch("/api/spot", { method: "DELETE" });
  } catch (err) {
    // Return to the parking view even if the network call failed.
  }
  renderParkView();
});

function renderParkView() {
  if (carMarker) { map.removeLayer(carMarker); carMarker = null; }
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  pending = null;
  els.findView.classList.add("hidden");
  els.parkView.classList.remove("hidden");
  els.parkForm.classList.add("hidden");
  els.parkBtn.classList.remove("hidden");
  els.parkBtn.textContent = "📍 I parked here";
  els.noteInput.value = "";
  els.movebyInput.value = "";
}

function renderFindView(spot) {
  els.parkView.classList.add("hidden");
  els.saveBtn.textContent = "Save spot";
  els.findView.classList.remove("hidden");

  setCarMarker(spot.lat, spot.lng, false);
  map.setView([spot.lat, spot.lng], 18);

  els.walkBtn.href = `https://maps.apple.com/?daddr=${spot.lat},${spot.lng}&dirflg=w`;

  if (spot.note) {
    els.noteDisplay.textContent = spot.note;
    els.noteDisplay.classList.remove("hidden");
  } else {
    els.noteDisplay.classList.add("hidden");
  }

  renderMoveByBanner(spot.moveBy);

  els.distance.textContent = "Locating you…";
  watchMyLocation(spot);
}

function renderMoveByBanner(moveBy) {
  if (!moveBy) { els.movebyBanner.classList.add("hidden"); return; }
  const when = new Date(moveBy).toLocaleString("en-US", {
    weekday: "short", hour: "numeric", minute: "2-digit",
  });
  const msLeft = moveBy - Date.now();
  els.movebyBanner.classList.remove("hidden");
  if (msLeft < 0) {
    els.movebyBanner.textContent = `⚠️ Move-by time passed (${when})`;
    els.movebyBanner.classList.add("urgent");
  } else {
    els.movebyBanner.textContent = `Move by ${when}`;
    els.movebyBanner.classList.toggle("urgent", msLeft <= 30 * 60 * 1000);
  }
}

function watchMyLocation(spot) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const me = [pos.coords.latitude, pos.coords.longitude];
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.circleMarker(me, { radius: 8, color: "#2563eb" }).addTo(map);
      const meters = haversineMeters(me, [spot.lat, spot.lng]);
      els.distance.textContent = formatDistance(meters);
    },
    () => { els.distance.textContent = "Tap 🧭 for directions"; },
    { enableHighAccuracy: true }
  );
}

// ---- Boot: decide which state to show ----
async function boot() {
  try {
    const res = await fetch("/api/spot");
    const spot = await res.json();
    if (spot && Number.isFinite(spot.lat)) {
      renderFindView(spot);
    } else {
      renderParkView();
    }
  } catch (err) {
    renderParkView();
  }
}
boot();
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check public/app.js`
Expected: no output, exit code 0. (Browser globals like `L` and `navigator` aren't resolved by `--check`; it only validates syntax.)

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: frontend behavior (geolocation, map, save/find, distance)"
```

---

## Task 7: Provision, deploy, verify

**Files:**
- Modify: `wrangler.jsonc` (replace `<KV_NAMESPACE_ID>`)
- Create: `.dev.vars` (gitignored)

- [ ] **Step 1: Create the KV namespace**

Run: `npx wrangler kv namespace create PARKING_KV`
Expected: output includes an `id`, e.g.
`{ "binding": "PARKING_KV", "id": "abc123..." }`
Copy the `id`.

- [ ] **Step 2: Put the KV id into `wrangler.jsonc`**

Replace `<KV_NAMESPACE_ID>` in `wrangler.jsonc` with the real id from Step 1.

- [ ] **Step 3: Create `.dev.vars` with the Discord webhook**

Create `.dev.vars` (it is gitignored) containing the webhook URL Yonatan provided in the design conversation:

```
DISCORD_WEBHOOK_URL="<paste the Discord webhook URL from the conversation>"
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — 8 tests green.

- [ ] **Step 5: End-to-end local test of the reminder**

Start the dev server: `npx wrangler dev --port 8787` (leave running).
Save a spot whose move-by is ~4 minutes out (inside the 5-min window) so the cron should fire immediately. Compute the timestamp and PUT it:

```bash
MOVEBY=$(node -e "console.log(Date.now() + 4*60*1000)")
curl -s -X PUT http://localhost:8787/api/spot -H 'Content-Type: application/json' \
  -d "{\"lat\":40.8506,\"lng\":-73.93,\"note\":\"local test\",\"moveBy\":$MOVEBY}"
```

Manually trigger the scheduled handler:

```bash
curl -s "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

Expected: a Discord message arrives in the target channel ("🚗 Move your car by …"). Then confirm it won't double-fire:

```bash
curl -s http://localhost:8787/api/spot   # reminderSent should now be true
curl -s "http://localhost:8787/__scheduled?cron=*+*+*+*+*"  # no second Discord message
```

Clean up: `curl -s -X DELETE http://localhost:8787/api/spot` and stop the dev server.

- [ ] **Step 6: Open the UI locally**

With `npx wrangler dev --port 8787` running, open `http://localhost:8787` in a browser.
Expected: map renders centered on Washington Heights; "📍 I parked here" is visible. (Geolocation may be denied on desktop — the draggable-pin fallback should appear.)

- [ ] **Step 7: Set the production secret**

Run: `npx wrangler secret put DISCORD_WEBHOOK_URL`
Paste the same webhook URL when prompted.

- [ ] **Step 8: Deploy**

Run: `npm run deploy`
Expected: deploy succeeds; output shows the `*.workers.dev` URL and a registered cron trigger `* * * * *`.

- [ ] **Step 9: Production smoke test**

Open the deployed URL on your iPhone. Confirm:
- "📍 I parked here" grabs GPS and drops a draggable pin.
- Saving with a note + a move-by ~6 min out flips to the "Find my car" view.
- "🧭 Walk to my car" opens Apple Maps walking directions.
- A Discord ping arrives ~5 minutes before the move-by time.
- "✓ Got my car" clears the spot and returns to the parking view.

- [ ] **Step 10: Commit the final config**

```bash
git add wrangler.jsonc
git commit -m "chore: wire KV namespace id and deploy"
```

---

## Self-Review Notes

- **Spec coverage:** auto-GPS + draggable pin (Tasks 5–6), cloud sync via KV (Tasks 3–4, 7), Discord ping 5 min before (Tasks 2, 4, 7), in-app move-by banner (Task 6), single current spot / overwrite (Task 4 PUT), Apple Maps only (Task 6), no auth (omitted by design), PWA add-to-home (Task 5). All covered.
- **Secret hygiene:** the real webhook URL never enters a committed file — `.dev.vars` is gitignored and the production value is set via `wrangler secret`.
- **No third-party runtime code:** Leaflet is vendored and served same-origin (Task 5 Step 0), so there are no external `<script>` tags and no CDN-compromise exposure. Map tiles are non-executable images from OpenStreetMap.
- **Type consistency:** the spot shape `{lat,lng,note,moveBy,createdAt,reminderSent}` is identical across `spot.js`, `index.js`, `reminder.js`, the tests, and `app.js`. `shouldFireReminder` / `buildDiscordPayload` / `sendDiscord` names match between `reminder.js` and `index.js`.
