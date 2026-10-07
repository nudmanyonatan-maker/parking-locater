// Settings and admin token check.
//   GET  /api/settings          AppSettings (public)
//   PUT  /api/settings          admin: partial update, validated by validateSettingsPatch
//   POST /api/settings/geocode  admin: re-geocode home, store it, resync the camera catalog
//   GET  /api/auth/check        admin: {ok: true} when the bearer token is valid

import { Hono } from 'hono';
import { validateSettingsPatch } from '../../shared/settings';
import { requireAdmin } from '../auth';
import { geocodeHome } from '../geocode';
import { HttpError, readJson, type AppEnv } from '../http';
import { syncCatalog } from '../services/cameras';
import { readSettings, saveHome, saveSettingsPatch } from '../services/settings';
import { TmcError } from '../tmc';
import type { ValidationDetail } from '../validation';

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get('/auth/check', requireAdmin, (c) => c.json({ ok: true }));

settingsRoutes.get('/settings', async (c) => c.json(await readSettings(c.env)));

settingsRoutes.put('/settings', requireAdmin, async (c) => {
  const result = validateSettingsPatch(await readJson(c));
  if (!result.ok) {
    const details: ValidationDetail[] = Object.entries(result.errors).map(([path, message]) => ({ path: path === '_' ? '(body)' : path, message }));
    throw new HttpError(400, 'validation_failed', details.map((d) => `${d.path}: ${d.message}`).join('; '), details);
  }
  return c.json(await saveSettingsPatch(c.env, result.value));
});

settingsRoutes.post('/settings/geocode', requireAdmin, async (c) => {
  const { home } = await readSettings(c.env);
  const geocoded = await geocodeHome(home.address);
  if (!geocoded) throw new HttpError(502, 'geocode_failed', 'Every geocoder failed; the home location was not changed.');
  await saveHome(c.env, geocoded);
  try {
    await syncCatalog(c.env);
  } catch (e) {
    if (e instanceof TmcError) throw new HttpError(502, 'catalog_unavailable', `Home updated, but the camera list could not be refreshed: ${e.message}`);
    throw e;
  }
  return c.json(await readSettings(c.env));
});
