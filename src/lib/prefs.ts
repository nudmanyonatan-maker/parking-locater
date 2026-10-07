// Device-only preferences kept in localStorage (never synced to the server).
// Storage can throw (private mode, blocked site data), so every access is
// guarded and the app falls back to defaults in memory.

import { useSyncExternalStore } from 'react';

export type AutoRefreshSeconds = 0 | 30 | 60;

export interface Prefs {
  /** Draw detection boxes / gaps / calibration regions over camera frames. */
  debugOverlays: boolean;
  /** 0 = manual refresh only. */
  autoRefreshSeconds: AutoRefreshSeconds;
  /** Admin bearer token, verified with GET /api/auth/check before it is stored. */
  adminToken: string | null;
  /** Cameras page: stop refreshing frames. */
  pauseImages: boolean;
}

const KEYS: Record<keyof Prefs, string> = {
  debugOverlays: 'pnm.debugOverlays',
  autoRefreshSeconds: 'pnm.autoRefreshSeconds',
  adminToken: 'pnm.adminToken',
  pauseImages: 'pnm.pauseImages',
};

const DEFAULTS: Prefs = { debugOverlays: false, autoRefreshSeconds: 0, adminToken: null, pauseImages: false };

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the in-memory value still applies for this session.
  }
}

function load(): Prefs {
  const auto = Number(readRaw(KEYS.autoRefreshSeconds));
  const token = readRaw(KEYS.adminToken);
  return {
    debugOverlays: readRaw(KEYS.debugOverlays) === '1',
    autoRefreshSeconds: auto === 30 || auto === 60 ? auto : DEFAULTS.autoRefreshSeconds,
    adminToken: token && token.trim() ? token : null,
    pauseImages: readRaw(KEYS.pauseImages) === '1',
  };
}

let current: Prefs = typeof window === 'undefined' ? DEFAULTS : load();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getPrefs(): Prefs {
  return current;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  current = { ...current, [key]: value };
  const raw = value === null ? null : typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  writeRaw(KEYS[key], raw);
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Keep tabs in sync (e.g. unlocking admin in another tab).
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith('pnm.')) {
      current = load();
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, () => DEFAULTS);
}
