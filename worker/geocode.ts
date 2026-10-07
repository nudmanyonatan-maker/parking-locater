// Geocode the home address: NYC GeoSearch, then the US Census geocoder, then
// Nominatim. Returns null when every provider fails (callers fall back to
// FALLBACK_HOME). Results outside New York City are rejected as mismatches.

import type { HomeLocation } from '../shared/types';
import { errorMessage } from './http';

const TIMEOUT_MS = 4_000;
const USER_AGENT = 'ParkNearMe/0.1 (personal street-parking app)';
/** Generous NYC bounding box; anything outside is a wrong match. */
const NYC_BOUNDS = { minLat: 40.45, maxLat: 40.95, minLon: -74.3, maxLon: -73.65 };

interface Provider {
  name: string;
  url(query: string): string;
  parse(body: unknown): { lat: number; lon: number } | null;
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);

function point(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const p = { lat: num(lat), lon: num(lon) };
  return Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
}

const field = (v: unknown, key: string): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : undefined);

const GEOCODERS: Provider[] = [
  {
    name: 'nyc-geosearch',
    url: (q) => `https://geosearch.planninglabs.nyc/v2/search?text=${q}&size=1`,
    parse: (body) => {
      const coords = field(field(first(field(body, 'features')), 'geometry'), 'coordinates');
      return Array.isArray(coords) ? point(coords[1], coords[0]) : null;
    },
  },
  {
    name: 'us-census',
    url: (q) => `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${q}&benchmark=Public_AR_Current&format=json`,
    parse: (body) => {
      const c = field(first(field(field(body, 'result'), 'addressMatches')), 'coordinates');
      return c ? point(field(c, 'y'), field(c, 'x')) : null;
    },
  },
  {
    name: 'nominatim',
    url: (q) => `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`,
    parse: (body) => {
      const hit = first(body);
      return hit ? point(field(hit, 'lat'), field(hit, 'lon')) : null;
    },
  },
];

const inNyc = (p: { lat: number; lon: number }) =>
  p.lat >= NYC_BOUNDS.minLat && p.lat <= NYC_BOUNDS.maxLat && p.lon >= NYC_BOUNDS.minLon && p.lon <= NYC_BOUNDS.maxLon;

export async function geocodeHome(address: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<HomeLocation | null> {
  const query = encodeURIComponent(address);
  for (const provider of GEOCODERS) {
    try {
      const res = await fetchImpl(provider.url(query), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hit = provider.parse(await res.json());
      if (!hit) throw new Error('no match');
      if (!inNyc(hit)) throw new Error(`match outside NYC (${hit.lat}, ${hit.lon})`);
      return { address, lat: hit.lat, lon: hit.lon, source: provider.name, geocodedAt: new Date().toISOString() };
    } catch (e) {
      console.error(`geocode: ${provider.name} failed: ${errorMessage(e)}`);
    }
  }
  return null;
}
