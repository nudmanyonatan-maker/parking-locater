// HTTP plumbing shared by the routes: the Hono env type, ApiError responses,
// and safe JSON body reading. Services throw HttpError; the app's error
// handler (worker/index.ts) renders it as an ApiError JSON body.

import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiError } from '../shared/types';
import type { Env } from './env';

export type AppEnv = { Bindings: Env };
export type AppContext = Context<AppEnv>;

/** The part of the execution context services need (Hono's and the Workers runtime's both fit). */
export interface Background {
  waitUntil(promise: Promise<unknown>): void;
}

/** Largest JSON request body we accept (calibrations are the biggest, ~5 KB). */
const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(code: string, message: string, details?: unknown): ApiError {
  return details === undefined ? { error: code, message } : { error: code, message, details };
}

export function apiError(c: AppContext, status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
  return c.json(errorBody(code, message, details), status);
}

/** Parse the request body as JSON, rejecting oversized or malformed bodies. */
export async function readJson(c: AppContext): Promise<unknown> {
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', `Request body must be under ${MAX_BODY_BYTES} bytes`);
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', `Request body must be under ${MAX_BODY_BYTES} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

/** Security and caching headers for every /api response. Routes may set their own Cache-Control. */
export const apiHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
