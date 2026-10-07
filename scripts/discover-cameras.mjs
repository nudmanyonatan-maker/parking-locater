#!/usr/bin/env node
// Camera discovery for ParkNearMe.
//
// 1. Geocodes the home address (NYC GeoSearch -> US Census -> Nominatim).
// 2. Fetches the NYC TMC camera catalog.
// 3. Keeps cameras within --radius miles, sorted by distance.
// 4. Pulls a short frame sequence from each to check liveness and refresh rate.
// 5. Writes feasibility/discovery.json plus the frames for inspection.
//
// Usage: node scripts/discover-cameras.mjs [--radius 0.75] [--frames 5] [--interval 4]
//          [--focus id1,id2 --focus-frames 30 --focus-interval 30]
// --focus records a longer time series for selected cameras (parking turnover).
// Needs open internet (runs in GitHub Actions; see .github/workflows/parknearme-camera-discovery.yml).

import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME_ADDRESS = '403 Audubon Ave, New York, NY 10033';
const TMC = 'https://webcams.nyctmc.org/api/cameras';
const UA = 'ParkNearMe-discovery/0.1 (personal parking MVP; github.com/yonatannudman/phone)';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const RADIUS_MI = Number(args.radius ?? 0.75);
const CONTEXT_RADIUS_MI = Number(args.context ?? 1.25);
const FRAMES = Number(args.frames ?? 5);
const INTERVAL_S = Number(args.interval ?? 4);
const FOCUS = String(args.focus ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const FOCUS_FRAMES = Number(args['focus-frames'] ?? 30);
const FOCUS_INTERVAL_S = Number(args['focus-interval'] ?? 30);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'feasibility');
const framesDir = join(outDir, 'frames');
const rawDir = join(outDir, 'raw');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineMiles(a, b) {
  const R = 3958.7613;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const started = Date.now();
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms), headers: { 'User-Agent': UA, ...(opts.headers ?? {}) } });
  return { res, ms: Date.now() - started };
}

// --- geocoding -----------------------------------------------------------------

async function geocode() {
  const attempts = [];
  const q = encodeURIComponent(HOME_ADDRESS);
  const providers = [
    {
      name: 'NYC GeoSearch (planninglabs)',
      url: `https://geosearch.planninglabs.nyc/v2/search?text=${q}&size=1`,
      parse: (j) => {
        const f = j.features?.[0];
        return f && { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties?.label, bbl: f.properties?.addendum?.pad?.bbl };
      },
    },
    {
      name: 'US Census geocoder',
      url: `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${q}&benchmark=Public_AR_Current&format=json`,
      parse: (j) => {
        const m = j.result?.addressMatches?.[0];
        return m && { lat: m.coordinates.y, lon: m.coordinates.x, label: m.matchedAddress };
      },
    },
    {
      name: 'Nominatim (OSM)',
      url: `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`,
      parse: (j) => j[0] && { lat: Number(j[0].lat), lon: Number(j[0].lon), label: j[0].display_name },
    },
  ];
  for (const p of providers) {
    try {
      const { res } = await fetchWithTimeout(p.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hit = p.parse(await res.json());
      attempts.push({ provider: p.name, ok: !!hit, result: hit ?? null });
    } catch (e) {
      attempts.push({ provider: p.name, ok: false, error: String(e) });
    }
  }
  const primary = attempts.find((a) => a.ok);
  if (!primary) throw new Error(`Geocoding failed: ${JSON.stringify(attempts)}`);
  return { address: HOME_ADDRESS, ...primary.result, source: primary.provider, attempts };
}

// --- JPEG helpers ----------------------------------------------------------------

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

const pickHeaders = (h) =>
  Object.fromEntries(
    ['content-type', 'content-length', 'cache-control', 'last-modified', 'etag', 'date', 'expires', 'age', 'access-control-allow-origin', 'server', 'x-cache', 'cf-cache-status']
      .map((k) => [k, h.get(k)])
      .filter(([, v]) => v !== null),
  );

async function grabFrame(cam, n) {
  const url = `${TMC}/${cam.id}/image?t=${Date.now()}`;
  const fetchedAt = new Date().toISOString();
  try {
    const { res, ms } = await fetchWithTimeout(url, { headers: { Origin: 'https://parknearme.example' } }, 15000);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(buf).digest('hex');
    const size = jpegSize(buf);
    let file = null;
    if (res.ok && size) {
      file = `frames/${cam.id}-${n}.jpg`;
      await writeFile(join(outDir, file), buf);
    }
    return { n, fetchedAt, status: res.status, ms, bytes: buf.length, sha256: sha, jpeg: size, file, headers: pickHeaders(res.headers) };
  } catch (e) {
    return { n, fetchedAt, error: String(e) };
  }
}

// --- main ------------------------------------------------------------------------

async function main() {
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });

  const home = await geocode();
  console.log(`Home: ${home.lat}, ${home.lon} via ${home.source} (${home.label ?? ''})`);

  const { res: catRes, ms: catMs } = await fetchWithTimeout(`${TMC}/`, { headers: { Origin: 'https://parknearme.example' } }, 30000);
  const catalogHeaders = pickHeaders(catRes.headers);
  const catalog = await catRes.json();
  console.log(`Catalog: HTTP ${catRes.status}, ${catalog.length} cameras, ${catMs} ms`);

  const fieldNames = [...new Set(catalog.flatMap((c) => Object.keys(c)))].sort();
  const fieldTypes = Object.fromEntries(fieldNames.map((k) => [k, [...new Set(catalog.map((c) => typeof c[k]))]]));

  const withDist = catalog
    .map((c) => {
      const lat = Number(c.latitude);
      const lon = Number(c.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { raw: c, id: c.id, name: c.name, area: c.area, lat, lon, isOnline: String(c.isOnline) === 'true',
        distanceMi: haversineMiles(home, { lat, lon }), bearingDeg: bearingDeg(home, { lat, lon }) };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceMi - b.distanceMi);

  const nearby = withDist.filter((c) => c.distanceMi <= RADIUS_MI);
  const context = withDist.filter((c) => c.distanceMi > RADIUS_MI && c.distanceMi <= CONTEXT_RADIUS_MI);
  console.log(`${nearby.length} cameras within ${RADIUS_MI} mi; ${context.length} more within ${CONTEXT_RADIUS_MI} mi`);

  // Frame sequences for nearby cameras (all cameras in parallel, one request per camera per interval).
  const sequences = Object.fromEntries(nearby.map((c) => [c.id, []]));
  for (let n = 0; n < FRAMES; n++) {
    const shots = await Promise.all(nearby.map((c) => grabFrame(c, n)));
    shots.forEach((s, i) => sequences[nearby[i].id].push(s));
    if (n < FRAMES - 1) await sleep(INTERVAL_S * 1000);
  }
  // One frame each for the context ring.
  const contextShots = await Promise.all(context.map((c) => grabFrame(c, 0)));

  // Optional long time series for selected cameras (continues the frame numbering).
  const focusCams = nearby.filter((c) => FOCUS.includes(c.id));
  if (focusCams.length) {
    console.log(`Focus: ${focusCams.length} cameras x ${FOCUS_FRAMES} frames every ${FOCUS_INTERVAL_S}s`);
    for (let k = 0; k < FOCUS_FRAMES; k++) {
      await sleep(FOCUS_INTERVAL_S * 1000);
      const shots = await Promise.all(focusCams.map((c) => grabFrame(c, FRAMES + k)));
      shots.forEach((s, i) => sequences[focusCams[i].id].push(s));
    }
  }

  const summarize = (c, frames) => {
    const ok = frames.filter((f) => f.status === 200 && f.jpeg);
    const distinct = new Set(ok.map((f) => f.sha256)).size;
    return {
      id: c.id, name: c.name, area: c.area, lat: c.lat, lon: c.lon,
      distanceMi: Number(c.distanceMi.toFixed(3)), bearingDeg: Math.round(c.bearingDeg),
      catalogIsOnline: c.isOnline, raw: c.raw,
      fetchedOk: ok.length, attempted: frames.length, distinctFrames: distinct,
      imageSize: ok[0]?.jpeg ?? null, avgBytes: ok.length ? Math.round(ok.reduce((s, f) => s + f.bytes, 0) / ok.length) : null,
      frames,
    };
  };

  const report = {
    generatedAt: new Date().toISOString(),
    runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    home,
    radiusMi: RADIUS_MI,
    contextRadiusMi: CONTEXT_RADIUS_MI,
    frameSequence: { frames: FRAMES, intervalSeconds: INTERVAL_S },
    focus: focusCams.length ? { cameraIds: focusCams.map((c) => c.id), frames: FOCUS_FRAMES, intervalSeconds: FOCUS_INTERVAL_S } : null,
    catalog: { status: catRes.status, ms: catMs, count: catalog.length, headers: catalogHeaders, fieldNames, fieldTypes, sample: catalog.slice(0, 2) },
    nearby: nearby.map((c) => summarize(c, sequences[c.id])),
    context: context.map((c, i) => summarize(c, [contextShots[i]])),
  };

  // Terms / disclaimer pages, saved for the README's terms section.
  const termsUrls = ['https://webcams.nyctmc.org/', 'https://webcams.nyctmc.org/terms', 'https://www.nyc.gov/main/terms-of-use', 'https://www.nyc.gov/html/dot/html/motorist/atis.shtml'];
  report.termsPages = [];
  for (const u of termsUrls) {
    try {
      const { res } = await fetchWithTimeout(u, {}, 15000);
      const text = await res.text();
      const file = `raw/${u.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.html`;
      await writeFile(join(outDir, file), text.slice(0, 400_000));
      report.termsPages.push({ url: u, status: res.status, finalUrl: res.url, file, bytes: text.length });
    } catch (e) {
      report.termsPages.push({ url: u, error: String(e) });
    }
  }

  await writeFile(join(outDir, 'discovery.json'), JSON.stringify(report, null, 2));
  for (const c of report.nearby) {
    console.log(`${c.distanceMi.toFixed(3)} mi  ${c.fetchedOk}/${c.attempted} ok  ${c.distinctFrames} distinct  ${c.catalogIsOnline ? 'online ' : 'OFFLINE'}  ${c.name}  [${c.id}]`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
