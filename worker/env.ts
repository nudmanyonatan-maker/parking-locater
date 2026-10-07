// Worker bindings and environment, with light validation.

export interface Env {
  DB: D1Database;
  /** Workers AI binding. Absent in some local/test setups. */
  AI?: Ai;
  ASSETS?: Fetcher;
  /** "Where's my car": the current parking spot. */
  PARKING_KV: KVNamespace;
  /** Secret. Discord webhook for the move-by reminder. */
  DISCORD_WEBHOOK_URL?: string;
  /** Secret. Bearer token for admin routes (calibration, usefulness, settings). */
  ADMIN_TOKEN?: string;
  /** Secrets for Web Push (base64url). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** e.g. "mailto:you@example.com" */
  VAPID_SUBJECT?: string;
  /** Override for the camera API (dev fixtures). Default: https://webcams.nyctmc.org/api/cameras */
  TMC_BASE_URL?: string;
  /** "workers-ai" (default) or "fixture" (dev only: replays recorded detections). */
  DETECTOR?: string;
  /** Dev only: base URL serving recorded detections by frame hash. */
  FIXTURE_DETECTIONS_URL?: string;
  APP_VERSION?: string;
}

export const DEFAULT_TMC_BASE_URL = 'https://webcams.nyctmc.org/api/cameras';

export function tmcBaseUrl(env: Env): string {
  return (env.TMC_BASE_URL || DEFAULT_TMC_BASE_URL).replace(/\/+$/, '');
}

/** Problems that make a feature unavailable, reported by /api/health. */
export function configProblems(env: Env): Record<string, string | null> {
  return {
    db: env.DB ? null : 'D1 binding "DB" is missing',
    ai: env.AI || env.DETECTOR === 'fixture' ? null : 'Workers AI binding "AI" is missing; analysis disabled',
    admin: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 ? null : 'ADMIN_TOKEN secret missing or shorter than 16 chars; admin routes locked',
    kv: env.PARKING_KV ? null : 'KV binding "PARKING_KV" is missing; the car spot cannot be saved',
    discord: env.DISCORD_WEBHOOK_URL ? null : 'DISCORD_WEBHOOK_URL secret not set; move-by reminders are off',
    push:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
        ? null
        : 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not set; notifications disabled',
  };
}
