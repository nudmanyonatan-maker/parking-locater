// Worker entry: the Hono API under /api plus the cron handler. Static assets
// (the React SPA) are served by Cloudflare before the Worker runs; only
// /api/* reaches this code (assets.run_worker_first in wrangler.jsonc).

import { Hono } from 'hono';
import { scheduled } from './cron';
import type { Env } from './env';
import { apiHeaders, errorBody, HttpError, type AppEnv } from './http';
import { cameraRoutes } from './routes/cameras';
import { healthRoutes } from './routes/health';
import { parkingRoutes } from './routes/parking';
import { pushRoutes } from './routes/push';
import { settingsRoutes } from './routes/settings';
import { spotRoutes } from './routes/spot';

const isApiPath = (path: string) => path === '/api' || path.startsWith('/api/');

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use('/api/*', apiHeaders);

  app.route('/api', healthRoutes);
  app.route('/api', settingsRoutes);
  app.route('/api/cameras', cameraRoutes);
  app.route('/api/parking', parkingRoutes);
  app.route('/api/push', pushRoutes);
  app.route('/api/spot', spotRoutes);

  app.notFound((c) => {
    if (isApiPath(c.req.path)) return c.json(errorBody('not_found', `No API route for ${c.req.method} ${c.req.path}`), 404);
    // Normally unreachable (assets are served first), but keep the SPA working if it is.
    if (c.env?.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('Not found', 404);
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message, err.details), err.status);
    console.error(`error: ${c.req.method} ${c.req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return c.json(errorBody('internal_error', 'Something went wrong on the server. Try again.'), 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled,
} satisfies ExportedHandler<Env>;
