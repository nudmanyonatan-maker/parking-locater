// Settings stored as key/value JSON rows in application_settings.
// Besides the AppSettings fields (shared/settings.ts) there are internal keys:
//   home            HomeLocation (geocoded once; source "fallback" means retry)
//   app_last_seen_at ISO time the app last loaded /api/parking/current
//   app_origin      origin the app runs on (for absolute links in push payloads)

import { settingsFromRows, type SettingsPatch } from '../../shared/settings';
import type { AppSettings, HomeLocation } from '../../shared/types';
import { getSettingRows, putSettings } from '../db';
import type { Env } from '../env';

const LAST_SEEN_KEY = 'app_last_seen_at';
const ORIGIN_KEY = 'app_origin';
/** Write app_last_seen_at at most this often. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export interface SettingsState {
  settings: AppSettings;
  /** The stored home, or null when none has been stored yet. */
  storedHome: HomeLocation | null;
  appLastSeenAt: string | null;
  appOrigin: string | null;
}

function stringValue(rows: { key: string; value_json: string }[], key: string): string | null {
  const row = rows.find((r) => r.key === key);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value_json) as unknown;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export async function readSettingsState(env: Env): Promise<SettingsState> {
  const rows = await getSettingRows(env.DB);
  const settings = settingsFromRows(rows);
  return {
    settings,
    storedHome: rows.some((r) => r.key === 'home') ? settings.home : null,
    appLastSeenAt: stringValue(rows, LAST_SEEN_KEY),
    appOrigin: stringValue(rows, ORIGIN_KEY),
  };
}

export async function readSettings(env: Env): Promise<AppSettings> {
  return (await readSettingsState(env)).settings;
}

export async function saveSettingsPatch(env: Env, patch: SettingsPatch): Promise<AppSettings> {
  await putSettings(env.DB, Object.entries(patch), new Date().toISOString());
  return readSettings(env);
}

export async function saveHome(env: Env, home: HomeLocation): Promise<void> {
  await putSettings(env.DB, [['home', home]], new Date().toISOString());
}

export async function saveAppOrigin(env: Env, origin: string): Promise<void> {
  await putSettings(env.DB, [[ORIGIN_KEY, origin]], new Date().toISOString());
}

/** Record that the app is open (drives background checks); throttled to one write a minute. */
export async function touchAppLastSeen(env: Env, state: SettingsState, now = new Date()): Promise<void> {
  const last = state.appLastSeenAt ? Date.parse(state.appLastSeenAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < LAST_SEEN_WRITE_INTERVAL_MS) return;
  await putSettings(env.DB, [[LAST_SEEN_KEY, now.toISOString()]], now.toISOString());
}
