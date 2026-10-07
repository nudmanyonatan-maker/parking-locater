// GET /api/health: database, catalog, detections and configuration checks.

import { Hono } from 'hono';
import type { HealthResponse } from '../../shared/types';
import { catalogStats, lastDetectionAt } from '../db';
import { configProblems } from '../env';
import { errorMessage, type AppEnv } from '../http';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', async (c) => {
  const checks: HealthResponse['checks'] = {};
  let dbOk = false;
  try {
    await c.env.DB.prepare('SELECT 1').first();
    dbOk = true;
    checks.db = { ok: true };
  } catch (e) {
    checks.db = { ok: false, detail: errorMessage(e) };
  }

  if (dbOk) {
    const [catalog, lastDetection] = await Promise.all([catalogStats(c.env.DB), lastDetectionAt(c.env.DB)]);
    checks.catalog = catalog.count
      ? { ok: true, detail: `${catalog.count} cameras, synced ${catalog.lastSyncedAt}` }
      : { ok: false, detail: 'No cameras synced yet' };
    checks.lastDetectionAt = { ok: true, detail: lastDetection ?? 'never' };
  }

  const problems = configProblems(c.env);
  for (const key of ['ai', 'admin', 'kv', 'discord', 'push'] as const) {
    const problem = problems[key];
    checks[key] = problem ? { ok: false, detail: problem } : { ok: true };
  }

  const body: HealthResponse = { ok: dbOk, time: new Date().toISOString(), version: c.env.APP_VERSION ?? 'dev', checks };
  return c.json(body, dbOk ? 200 : 503);
});
