# Parking Locator

A personal parking app for around 403 Audubon Ave (Washington Heights), installable as a PWA. Two tabs:

- **Find parking**: looks at public NYC DOT traffic cameras and answers: is there an open spot my 2016 Ford Escape fits in, at least 5 ft from a hydrant? The live camera is right there to check, with tabs for every street camera within ~5 blocks. Below it: **street cleaning** on the blocks around home, and which side you can stay on the longest.
- **My car**: "I parked here" (GPS) or set it on the map, then find it again (distance, walking directions in Apple Maps). The **move-by time is set automatically from the block's street-cleaning signs**, and a Discord message reminds you 5 minutes before.

> Shows **possible parking**, never "legal parking guaranteed". A visibly empty curb can be a driveway, bus stop or a no-parking zone, and alternate-side rules are suspended on holidays. Always check the signs.

- Frontend: React 19 + TypeScript + Vite 8, Lucide icons, MapLibre + OpenFreeMap tiles (My car), light/dark, safe areas, PWA.
- Backend: one Cloudflare Worker (Hono) that also serves the app. KV holds the car spot; D1 holds cameras, calibrations and detections; Workers AI does vehicle detection; a cron runs every minute (move-by reminder) and every 2 minutes (background camera checks).
- Data: NYC TMC camera endpoints (proxied; frames never stored) and NYC DOT parking-sign open data for street cleaning (`src/data/street-cleaning.json`).

This repo started as the "Where's My Car" app (`docs/superpowers/`); the camera parking finder (ParkNearMe) was merged into it, keeping the `parking-locator` Worker, its URL, the saved spot and the Discord webhook.

See [`CAMERA_FEASIBILITY.md`](CAMERA_FEASIBILITY.md) for the camera-by-camera study this MVP is built around.

---

## How it works

```
NYC TMC camera ──► Worker /api/cameras/:id/image  (same-origin proxy, 3 s edge cache, sha-256 per frame)
                       │
                       ▼
             LIVE / STALE / OFFLINE check   (bytes unchanged > 2 min ⇒ STALE ⇒ no AI call)
                       │
                       ▼
       VehicleDetector (Workers AI)           DETR-ResNet-50 → fallback Moondream 3.1 "detect"
                       │  boxes (normalized), duplicate boxes removed (class-agnostic NMS)
                       ▼
       Curb-gap analysis (shared/curb-gaps.ts)
         • per-camera calibration: parking-lane quad (+ cars that fit), RESTRICTED / IGNORE / roadway polygons
         • homography: lane quad → unit rectangle (u along the street, v across); lane length = capacity × 6.1 m
         • each box → fitted ground footprint (matches the box's left/right/bottom edges; splits merged
           bumper-to-bumper boxes); footprints in the lane are parked, ones further out only occlude
         • 1-D occupancy grid per lane (0.25 m bins, prior 75% occupied), persisted in D1 and fused across
           checks: parked footprints add "occupied" evidence; elsewhere "free" evidence is weighted by how
           visible a car parked there would be (detector recall at that distance × not hidden behind
           other vehicles). Curb hidden behind a parked car or a bus stays unknown, never "free".
         • memory follows the "max detection age" setting (default 5 min); an identical (frozen) frame is
           never fused twice
         • gaps = runs of likely-free curb − RESTRICTED / IGNORE zones; a car needs ~6.1 m (5.6 m next to a
           no-parking zone); a gap must be visible in the CURRENT frame (remembered-but-hidden curb is
           never reported), and a partly hidden one is at most "possible"
         • confidence = P(gap long enough | measurement noise) × mean P(free) × far-field factor
           (pixels per metre along the curb) × calibration quality; optional VLM second opinion
                       │
                       ▼
       D1: detections + parking_candidates  ──► /api/parking/current ──► the one-screen answer
                                             └─► Web Push alert (deduped)
```

The parking verdict is behind a `ParkingDetector` interface (`worker/analysis/detector.ts`). `CurbGapParkingDetector` composes any `VehicleDetector` with the gap analysis, so a different model or provider can be swapped in without touching the rest of the app.

### Your car and hydrants
- **Car fit** (`shared/car.ts`): a 2016 Ford Escape is 178.1 in (4.52 m) long. An opening counts only if it is about 5.7 m (19 ft) long between two cars, or 5.1 m (17 ft) when one end is a hydrant zone or corner, which leaves room to swing in. Lengths come from the lane's perspective mapping (homography), so far-away openings are measured less precisely and get lower confidence.
- **Hydrants**: each parking lane lists its hydrants in metres from the lane start (`hydrantsM`). The analyzer never offers curb within 5 ft (1.52 m) of a hydrant. NYC's actual rule is 15 ft; 5 ft is a deliberate choice. The seeded W 181st St lane has hydrants at ~5 m and ~31 m, from NYC DEP hydrant data projected onto the NYC street centerline (see `migrations/0007_seed_hydrants.sql`).

### Street cleaning
`scripts/fetch_street_cleaning.py` pulls every broom-symbol sign within ~0.4 mi of home from NYC DOT's *Parking Regulation Locations and Signs* dataset (`nfid-uabd`), groups them into block faces (street, cross streets, side) and keeps each sign's position and text. `shared/cleaning.ts` parses the texts ("FRIDAY 11:30AM-1PM", "8AM-8:30AM EXCEPT SUNDAY"), finds the next cleaning in New York time, and finds the block face a car is on (nearest face, other side offered as a one-tap switch; on long blocks the nearest sign's rule wins). The `Street-cleaning data` workflow refreshes the file monthly. Holiday suspensions aren't in the data; check @NYCASP.

### The answer
| Shown | Meaning |
|---|---|
| **Yes, N open spots** (green) | A confident opening that fits the car |
| **Maybe. Check the camera** (orange) | An opening that is uncertain (small, far, partly hidden) or a bit tight |
| **No open spots** (red) | Lane visible in a fresh frame, no opening |
| **Can't tell right now** (gray) | Camera offline or frozen, analysis failed, or no cars seen at all (usually darkness or glare) |

Detections older than 5 minutes, or taken from a frame that wasn't live, never count as current parking.

---

## Repository layout

```
src/                 React app: Find parking (/), My car (/car), /calibrate/:id (fix a camera's curb outline)
  data/              street-cleaning.json (NYC DOT signs near home)
public/              manifest, icons, service worker (sw.js)
worker/              Cloudflare Worker: Hono API, car spot + Discord reminder (car.ts), D1 repository, cron, analysis
  analysis/          ParkingDetector + VehicleDetector implementations, VLM verifier
shared/              API contract (types.ts) + pure logic used by both sides (curb gaps, street cleaning, car fit)
migrations/          D1 schema (+ seed for the Audubon/181st camera)
seed/                starting calibrations drawn on real frames
scripts/             camera discovery, street-cleaning fetch, offline DETR check, eval, dev fixtures, VAPID, D1 setup
feasibility/         output of the camera-discovery workflow (frames, contact sheets, detections)
tests/               Vitest (unit + API tests with a node:sqlite D1 shim and an in-memory KV)
docs/superpowers/    original "Where's My Car" design and plan
```

Workflows: `deploy.yml` (check + deploy), `camera-discovery.yml` (feasibility runs), `street-cleaning.yml` (monthly sign refresh).

---

## Setup

Requirements: Node 22+, npm, a Cloudflare account (free plan works).

```bash
npm install
```

### Local development

The Workers AI binding has no local simulator, so `vite dev` normally opens a remote session and needs a Cloudflare login. You have two options:

**A. With Cloudflare (real cameras, real AI):**
```bash
npx wrangler login
cp .dev.vars.example .dev.vars            # set ADMIN_TOKEN (16+ chars), DISCORD_WEBHOOK_URL
npm run db:migrate:local                  # create local D1 tables
npm run dev                               # http://localhost:5173
```
Workers AI calls made from dev are real calls and are billed (normally within the free allocation).

**B. Fully offline (recorded real frames + recorded DETR output):**
```bash
cp .dev.vars.example .dev.vars            # uncomment TMC_BASE_URL, DETECTOR=fixture, FIXTURE_DETECTIONS_URL
npm run db:migrate:local
npm run dev:fixtures                      # terminal 1: replays feasibility/ frames + detections
PARKNEARME_LOCAL_ONLY=1 npm run dev       # terminal 2
```

Trigger the cron locally: `curl "http://localhost:5173/cdn-cgi/local/scheduled?cron=*+*+*+*+*"`.

### Checks
```bash
npm run typecheck    # wrangler types + tsc -b (app, worker, node configs)
npm run lint
npm test             # vitest
npm run build
npm run check        # all of the above
npm run eval         # run the gap analysis over recorded real frames (feasibility/)
```

---

## Deploying to Cloudflare

### Option 1: GitHub Actions (recommended)

`.github/workflows/deploy.yml` runs typecheck, lint, tests and build on every push and pull request. Pushes to `main` (and manual runs) also deploy when these repository secrets exist (Settings → Secrets and variables → Actions). Any Cloudflare account works; the app's link is `parking-locator.<that account's workers.dev subdomain>.workers.dev`, so use a personal account (set its subdomain once under Workers & Pages before the first deploy):

| Secret | Required | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yes | Start from the "Edit Cloudflare Workers" template and **add Account → D1 → Edit**. Add Account → Workers AI → Read if a deploy complains about the AI binding. |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Dashboard → Workers & Pages → right sidebar |
| `DISCORD_WEBHOOK_URL` | recommended | The Discord webhook for "move your car" pings (Discord channel → Edit → Integrations → Webhooks → Copy URL). Set on the Worker at each deploy. |
| `PARKNEARME_ADMIN_TOKEN` | recommended | Any random string of 16+ characters (e.g. `openssl rand -base64 32`). Unlocks calibration, camera labels and settings. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | optional | From `npm run vapid`. If absent, the workflow generates a pair once and stores it on the Worker. |

What the workflow does: `npm run db:ensure` finds or creates the `parknearme` D1 database and `npm run kv:ensure` the car-spot KV namespace (keeps the configured one if it's in the account, else finds or creates `parking-locator-spot`), writing their ids into `wrangler.jsonc`. Then it builds, runs `wrangler d1 migrations apply parknearme --remote` and `wrangler deploy`, sets the secrets, and prints the `*.workers.dev` URL in the run summary.

### Option 2: from your machine

```bash
npx wrangler login                              # Cloudflare authentication
npm run db:ensure                               # = wrangler d1 create parknearme + writes database_id
npm run build
npm run db:migrate:remote                       # = wrangler d1 migrations apply parknearme --remote
npx wrangler deploy
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
node scripts/generate-vapid-keys.mjs --json | npx wrangler secret bulk   # reads stdin; nothing written to disk
```

Change `VAPID_SUBJECT` in `wrangler.jsonc` to a `mailto:` address you own (push services use it as a contact).

### Logs
```bash
npx wrangler tail            # live logs (npm run logs)
```
Observability is enabled in `wrangler.jsonc`, so logs are also under Workers & Pages → parking-locator → Logs.

The `DISCORD_WEBHOOK_URL` secret from the original app stays on the Worker across deploys. To change it: `npx wrangler secret put DISCORD_WEBHOOK_URL`.

---

## Using it

1. Open the app on your phone → Share → **Add to Home Screen**. It opens on **My car** while the car is parked, else on **Find parking**.
2. **Find parking**: the answer (spot / fits your Escape / hydrant distance), the live camera with the spot and hydrants outlined, and **Check again**. Tabs above the camera (**W 181st · Amsterdam · St Nicholas**) show every street camera within ~5 blocks; only W 181st is checked for parking. Below: street cleaning around home.
3. **My car**: tap **I parked here** at the car (or **Set it on the map**). The app finds the block side, its cleaning schedule and sets **Move by** to the next cleaning; Discord pings you 5 minutes before. Wrong side? Tap "Parked on the … side instead?". **Note** lets you add a note or set the time by hand, **Move** re-places the pin, **Got it** clears it when you take the car. The 🏠 button sets home to where you are (kept on this phone).

The camera TMC calls "Audobon Ave @ W 181 ST" comes pre-set: it looks east along W 181st St at the north curb between Audubon and Amsterdam, with that curb lane and its hydrants already marked (`seed/calibrations.json`, migrations `0002` and `0007`). If the camera gets re-aimed, fix the outline at `/calibrate/1ccb8d7c-43d4-450e-b40c-79527766db75` (desktop recommended; it asks for the admin token, the `PARKNEARME_ADMIN_TOKEN` secret).

### Admin token (behind the scenes)
Find parking and My car need no token (as in the original app, the car spot API is open). Everything that changes camera analysis or costs money is protected:
- calibration, usefulness, settings, catalog resync, push subscribe/test, and forced analysis of any camera require `Authorization: Bearer <ADMIN_TOKEN>` (constant-time comparison).
- Public analysis is limited to watched cameras and is rate-limited per camera by `analysisCooldownSeconds` (default 45 s). The slot is claimed atomically in D1 before any frame fetch or AI call, and concurrent requests in one isolate share a single run. That caps AI spend and upstream DOT requests no matter who calls it. A caller that loses the race gets the latest stored result, or HTTP 429 `analysis_in_progress` if there is none yet.
- For stronger privacy, put the whole Worker behind **Cloudflare Access** (Zero Trust → Access → Applications → self-hosted, your email). It's free for up to 50 users and needs no code changes. Note that the Cache API is unavailable behind Access, so frames are simply fetched uncached.

### Notifications
The simplified app has no alerts switch; the backend support below is still there if you want it back.

Web Push uses VAPID with `aes128gcm` encryption, via `@block65/webcrypto-web-push`, which uses WebCrypto only. Payloads use the Declarative Web Push format, which iOS 18.4+ shows without waking the service worker. On iPhone, push only works for the **Home Screen app** on iOS 16.4+. An alert fires when all of these hold:
- notifications are on
- the candidate is within your radius
- `candidateSpaces > 0`
- confidence ≥ your minimum
- the detection came from a live frame and is under 5 minutes old

Each spot is alerted at most once per 30 minutes (several open spots don't take turns re-alerting), and you get at most one push every 5 minutes. Both limits are claimed atomically, so simultaneous analyses can't double-send.

---

## Cost (personal use)

| Item | Usage | Cost |
|---|---|---|
| Workers (Free) | 100k requests/day included. A day of use is a few hundred API calls; the cron runs 720×/day and is a no-op when idle. | $0 |
| Static assets | Not billed as Worker requests | $0 |
| D1 (Free) | 5M reads / 100k writes per day included. Each analysis ≈ 3–6 row writes. Detections are pruned after 7 days. | $0 |
| Workers AI | 10,000 neurons/day free. DETR ≈ 0.7 neurons/frame. Moondream fallback ≈ 20–30 neurons/frame (estimate). Gemma second opinion ≈ 5–13 neurons (estimate, off by default). | $0 for normal use |
| Images | Never stored (no R2) | $0 |

Worst case: background mode set to *Always* for 3 cameras, every 2 minutes, all day, is about 2,200 analyses/day. With DETR that is about 1,500 neurons (free). If DETR has been retired and the Moondream fallback is used, it is about 55k neurons/day: roughly $0.50/day on the Workers Paid plan ($5/month base), and on the Free plan Workers AI stops after the daily 10k neurons. The default mode (*With alerts*) only runs in the background while alerts are on or the app was opened in the last 15 minutes.

CPU: the Free plan allows 10 ms CPU per request. The Worker never decodes JPEGs; it only hashes them and forwards bytes to Workers AI. Measured in Node, the gap analysis takes about 1.5–6 ms per frame once warm, but about 20 ms on the first run in a fresh isolate (JIT warm-up). If you see `Exceeded CPU` / error 1102 in the logs on cold starts, move to Workers Paid ($5/month, 30 s CPU).

---

## NYC DOT / TMC camera terms

**Read this before sharing the app with anyone.** This is a summary, not legal advice.

What was verified (from the GitHub Actions discovery run, 2026-10-07):
- `GET https://webcams.nyctmc.org/api/cameras/` returns a JSON array of 976 cameras: `{id, name, latitude, longitude, area, isOnline: "true"|"false" (a string), imageUrl}`, with `cache-control: no-store` and **no `Access-Control-Allow-Origin`**.
- `GET /api/cameras/{id}/image` returns the current JPEG, mostly 352×240 (some highway cameras are 720×480), 13–38 KB, `no-store`, with a new frame every ~1–4 s and a burned-in clock. AXIS cameras also write an EXIF capture time.
- No API key is needed.

What others found:
- An offline camera answers HTTP 200 with a 5,485-byte PNG reading "This camera is being serviced", labelled `image/jpeg`. ParkNearMe treats it as OFFLINE.
- No rate limit is published. DOT's subscriber guidance says static cameras update about every 15 s. Repos polling at 1 request/s per camera report no 429s.

Terms and restrictions:
- **No open-data license.** The cameras sit under the **NYC.gov Terms of Use** (https://www.nyc.gov/main/terms-of-use): lawful use only, don't disrupt the servers, and images are property of the City of New York.
- **NYC DOT has enforced this.** In Nov 2024 it sent a cease-and-desist to the public "Traffic Cam Photobooth" site, calling it unauthorized use of the traffic cameras under those terms.
- **Formal access** is through DOT's *Video and Traffic Flow Data Sharing Partnership Agreement* (apply via `TMCDOT@dot.nyc.gov`; see https://webcams.nyctmc.org/subscribers). It permits "news-oriented" uses, requires attribution to NYC DOT, forbids copying ("transferring") the feed contents to your own site, and forbids use in advertising without written consent.
- NYC DOT states its cameras provide live images only and do not record.

How ParkNearMe stays on the conservative side:
- **Personal use.** It fetches only the handful of cameras near one address, at human-scale rates: frames are cached at the edge for 3 s, and analysis is limited to one run per camera per 45 s.
- **Nothing is stored or redistributed.** Frames are analyzed in memory; only numbers and boxes go to D1.
- **Credit** "Camera imagery: NYC DOT" is shown in the app.
- **Recommended:** keep the deployment private with Cloudflare Access (see *Admin protection*). The `/api/cameras/:id/image` proxy re-serves DOT frames from your domain. That is needed for same-origin analysis, but on a public URL it looks like mirroring.
- If you ever want to share it beyond yourself, email `TMCDOT@dot.nyc.gov` first.

Uncertain: the exact text behind the "Terms of Use" link on webcams.nyctmc.org couldn't be retrieved (the site is a JS app), and whether a private, personal pass-through proxy is acceptable to DOT has not been confirmed.

---

## Privacy

No face recognition, no license-plate recognition, no person tracking. Only vehicle boxes and empty curb space are computed; non-vehicle detections are discarded. At 352×240, these cameras can't resolve faces or plates anyway. Frames are proxied and analyzed in memory and **never stored**. D1 keeps only numbers and boxes. The `feasibility/` folder holds a one-off set of development frames from the discovery run; delete it whenever you like.

---

## Known limitations

- **Camera coverage is the real limit.** Near 403 Audubon, only a few of the 16 cameras within 0.75 mi show curb parking at all (see `CAMERA_FEASIBILITY.md`). Most point at highways and ramps.
- **Resolution.** At 352×240, a car slot is about 40 px near the camera and under 10 px far away. Only the near part of each view supports confident measurements; far gaps are reported as low-confidence "possible" at best.
- **Night and glare.** If no cars are detected in a lane that should have some, the result is `unknown` instead of "empty street".
- **Legality is only partly known.** Hydrants (5 ft) and what you mark as RESTRICTED are excluded on the camera curb; street cleaning is shown from signs. Meters, loading zones, temporary signs and holiday suspensions are not modeled.
- **Moving vs parked.** A single frame can't tell a car waiting in the parking lane from a parked one. Temporal consistency across checks helps; a double-parked car may hide a real gap.
- **Workers AI model availability.** `@cf/facebook/detr-resnet-50` was removed from the public catalog in September 2026. The app tries it first and falls back to `@cf/moondream/moondream3.1-9B-A2B` automatically. Moondream boxes have no scores and cost more. Neither path has been run against a live account from this environment (no credentials), so the first real analysis will confirm which one works.
- **Freshness** is judged from frame bytes changing, plus our fetch times. The burned-in timestamp is not OCR'd.
- **Approximate location.** Parking markers sit at the lane's anchor (set in calibration) or next to the camera. They are not GPS-exact.
- Cron runs every minute (reminder); camera checks every 2 minutes. For faster updates, keep the app open: it re-checks on refresh and on an optional 30/60 s auto-refresh.
