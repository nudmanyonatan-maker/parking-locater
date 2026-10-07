// Per-isolate sharing of in-flight work: concurrent callers asking for the
// same thing (same database, same key) get one promise instead of each doing
// the work. This is only an optimization; limits that must hold across
// isolates are enforced in D1 (see claimAnalysisSlot in db.ts).

import type { Background } from './http';

export class InFlight<T> {
  private readonly byScope = new WeakMap<object, Map<string, Promise<T>>>();

  /** The promise already running for (scope, key), or a new one from start(). */
  run(scope: object, key: string, ctx: Background, start: () => Promise<T>): Promise<T> {
    let runs = this.byScope.get(scope);
    if (!runs) this.byScope.set(scope, (runs = new Map()));
    const running = runs.get(key);
    if (running) return running;
    const map = runs;
    const promise = start().finally(() => map.delete(key));
    map.set(key, promise);
    // Other requests may be waiting on it: keep it alive even if the request that started it goes away.
    ctx.waitUntil(promise.catch(() => {}));
    return promise;
  }
}
