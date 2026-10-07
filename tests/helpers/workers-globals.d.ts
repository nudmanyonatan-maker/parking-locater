// Minimal Cloudflare Workers globals for the Node test project.
//
// Tests import worker/ code, so tsconfig.node.json (Node + DOM libs) type-checks
// it too. The full generated worker-configuration.d.ts cannot be loaded there
// (it redeclares Request, Response, fetch, ... and clashes with the DOM lib),
// so this file declares only the Workers-specific names the worker code uses.
// The Worker itself is still checked against the real types by
// tsconfig.worker.json.

interface D1Meta {
  duration: number;
  last_row_id: number;
  changes: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  size_after: number;
}

interface D1Result<T = unknown> {
  success: true;
  meta: D1Meta & Record<string, unknown>;
  results: T[];
}

interface D1ExecResult {
  count: number;
  duration: number;
}

declare abstract class D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

declare abstract class D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

declare abstract class Ai {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: unknown;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface ExportedHandler<Env = unknown> {
  fetch?: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
  scheduled?: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => void | Promise<void>;
}

/** Workers add a default cache to the CacheStorage global. */
interface CacheStorage {
  readonly default: Cache;
}

declare abstract class KVNamespace {
  get<T = unknown>(key: string, type: 'json'): Promise<T | null>;
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
