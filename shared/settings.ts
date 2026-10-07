// Server-side settings: keys, defaults and validation.

import type { AppSettings, BackgroundMode, HomeLocation } from './types';

export const HOME_ADDRESS = '403 Audubon Ave, New York, NY 10033';

/**
 * Used only if every geocoder fails. Value is what NYC GeoSearch returned for
 * the address during camera discovery (2026-10-07, BBL 1021560035).
 */
export const FALLBACK_HOME: HomeLocation = {
  address: HOME_ADDRESS,
  lat: 40.851304,
  lon: -73.930153,
  source: 'fallback (NYC GeoSearch result recorded 2026-10-07)',
  geocodedAt: '2026-10-07T04:26:30.000Z',
};

export const RADIUS_OPTIONS = [0.25, 0.5, 0.75] as const;
export const BACKGROUND_MODES: BackgroundMode[] = ['off', 'when_alerts_on', 'always'];

/** Cameras farther than this are not stored at all. */
export const CATALOG_RADIUS_MI = 1.0;

export const DEFAULT_SETTINGS: AppSettings = {
  home: FALLBACK_HOME,
  radiusMi: 0.5,
  minConfidence: 0.6,
  notificationsEnabled: false,
  backgroundMode: 'when_alerts_on',
  analysisCooldownSeconds: 45,
  maxDetectionAgeSeconds: 300,
  vlmVerify: false,
};

export type SettingsPatch = Partial<Omit<AppSettings, 'home'>>;

/** Validate a partial settings update. Returns errors keyed by field. */
export function validateSettingsPatch(input: unknown): { ok: true; value: SettingsPatch } | { ok: false; errors: Record<string, string> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { _: 'Expected an object' } };
  const src = input as Record<string, unknown>;
  const out: SettingsPatch = {};
  const errors: Record<string, string> = {};
  const allowed = new Set(['radiusMi', 'minConfidence', 'notificationsEnabled', 'backgroundMode', 'analysisCooldownSeconds', 'maxDetectionAgeSeconds', 'vlmVerify']);
  for (const key of Object.keys(src)) if (!allowed.has(key)) errors[key] = 'Unknown setting';

  if ('radiusMi' in src) {
    if ((RADIUS_OPTIONS as readonly unknown[]).includes(src.radiusMi)) out.radiusMi = src.radiusMi as AppSettings['radiusMi'];
    else errors.radiusMi = `Must be one of ${RADIUS_OPTIONS.join(', ')}`;
  }
  if ('minConfidence' in src) {
    const v = src.minConfidence;
    if (typeof v === 'number' && v >= 0.1 && v <= 0.95) out.minConfidence = Math.round(v * 100) / 100;
    else errors.minConfidence = 'Must be a number between 0.1 and 0.95';
  }
  for (const key of ['notificationsEnabled', 'vlmVerify'] as const) {
    if (key in src) {
      if (typeof src[key] === 'boolean') out[key] = src[key];
      else errors[key] = 'Must be true or false';
    }
  }
  if ('backgroundMode' in src) {
    if (BACKGROUND_MODES.includes(src.backgroundMode as BackgroundMode)) out.backgroundMode = src.backgroundMode as BackgroundMode;
    else errors.backgroundMode = `Must be one of ${BACKGROUND_MODES.join(', ')}`;
  }
  if ('analysisCooldownSeconds' in src) {
    const v = src.analysisCooldownSeconds;
    if (Number.isInteger(v) && (v as number) >= 15 && (v as number) <= 3600) out.analysisCooldownSeconds = v as number;
    else errors.analysisCooldownSeconds = 'Must be an integer between 15 and 3600';
  }
  if ('maxDetectionAgeSeconds' in src) {
    const v = src.maxDetectionAgeSeconds;
    if (Number.isInteger(v) && (v as number) >= 60 && (v as number) <= 3600) out.maxDetectionAgeSeconds = v as number;
    else errors.maxDetectionAgeSeconds = 'Must be an integer between 60 and 3600';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** Merge stored key/value rows over the defaults, dropping anything invalid. */
export function settingsFromRows(rows: { key: string; value_json: string }[]): AppSettings {
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  const patch: Record<string, unknown> = {};
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (row.key === 'home') {
      const h = value as Partial<HomeLocation>;
      if (h && typeof h.lat === 'number' && typeof h.lon === 'number' && typeof h.address === 'string') {
        settings.home = { address: h.address, lat: h.lat, lon: h.lon, source: String(h.source ?? 'stored'), geocodedAt: String(h.geocodedAt ?? '') };
      }
    } else {
      patch[row.key] = value;
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    const one = validateSettingsPatch({ [key]: value });
    if (one.ok) Object.assign(settings, one.value);
  }
  return settings;
}
