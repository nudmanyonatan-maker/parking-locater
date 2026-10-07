// Admin authentication: a single shared bearer token (ADMIN_TOKEN secret).
// Admin routes change calibration, usefulness, settings and subscriptions.

import type { MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { apiError, type AppContext, type AppEnv } from './http';

/** Shorter tokens are treated as "not configured" so a weak secret never unlocks admin routes. */
const MIN_ADMIN_TOKEN_LENGTH = 16;

const encoder = new TextEncoder();

/**
 * Compare two strings in time that depends only on their lengths, not on
 * where they first differ. Pure JS so it behaves the same in Workers and Node.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

type AdminCheck = 'ok' | 'not_configured' | 'unauthorized';

function checkAdmin(env: Env, authorization: string | undefined): AdminCheck {
  const expected = env.ADMIN_TOKEN;
  if (!expected || expected.length < MIN_ADMIN_TOKEN_LENGTH) return 'not_configured';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  return match && constantTimeEqual(match[1]!, expected) ? 'ok' : 'unauthorized';
}

/** True when the request carries a valid admin token. Never throws. */
export function isAdmin(c: AppContext): boolean {
  return checkAdmin(c.env, c.req.header('Authorization')) === 'ok';
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const result = checkAdmin(c.env, c.req.header('Authorization'));
  if (result === 'not_configured') {
    return apiError(c, 503, 'admin_not_configured', 'Admin access is disabled: set the ADMIN_TOKEN secret (16+ characters).');
  }
  if (result === 'unauthorized') {
    c.header('WWW-Authenticate', 'Bearer');
    return apiError(c, 401, 'unauthorized', 'Missing or invalid admin token.');
  }
  await next();
};
