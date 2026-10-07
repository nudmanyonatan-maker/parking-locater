// Runs public/sw.js in a VM with fake service-worker globals.

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://parknearme.test';
const SHELL = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-DZvdjp00.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-At2By14n.css">
<link rel="manifest" href="/manifest.webmanifest" />
</head><body><div id="root"></div></body></html>`;

type Listener = (event: unknown) => void;

function loadServiceWorker(files: Record<string, string>) {
  let online = true;
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  const urlOf = (req: string | Request) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;

  const fetchFake = async (req: string | Request): Promise<Response> => {
    if (!online) throw new TypeError('Failed to fetch');
    const body = files[new URL(urlOf(req)).pathname];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  };
  const cacheFor = (store: Map<string, Response>) => ({
    match: async (req: string | Request) => store.get(urlOf(req))?.clone(),
    put: async (req: string | Request, res: Response) => void store.set(urlOf(req), res),
    add: async (req: string | Request) => {
      const res = await fetchFake(req);
      if (!res.ok) throw new TypeError('bad status');
      store.set(urlOf(req), res);
    },
    addAll: async (reqs: (string | Request)[]) => {
      const responses = await Promise.all(reqs.map((r) => fetchFake(r)));
      if (responses.some((r) => !r.ok)) throw new TypeError('bad status');
      reqs.forEach((r, i) => store.set(urlOf(r), responses[i]!));
    },
    keys: async () => [...store.keys()].map((u) => new Request(u)),
    delete: async (req: string | Request) => store.delete(urlOf(req)),
  });
  const open = (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    return store;
  };
  const caches = {
    open: async (name: string) => cacheFor(open(name)),
    match: async (req: string | Request, opts?: { cacheName?: string }) => {
      const names = opts?.cacheName ? [opts.cacheName] : [...stores.keys()];
      for (const n of names) {
        const hit = stores.get(n)?.get(urlOf(req));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  class SwRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
    }
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self,
    caches,
    fetch: fetchFake,
    Request: SwRequest,
    Response,
    URL,
  });

  return {
    stores,
    setOnline: (v: boolean) => {
      online = v;
    },
    async install() {
      const pending: Promise<unknown>[] = [];
      listeners.get('install')!({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
    },
    /** Dispatches a fetch event; resolves to the SW's response (or undefined when it doesn't respond). */
    async fetch(path: string, mode: RequestMode | 'navigate' = 'cors') {
      let responded: Promise<Response> | undefined;
      const request = { url: `${ORIGIN}${path}`, method: 'GET', mode };
      listeners.get('fetch')!({ request, respondWith: (p: Promise<Response>) => (responded = p) });
      return responded;
    },
  };
}

describe('service worker offline shell', () => {
  const files = {
    '/': SHELL,
    '/assets/index-DZvdjp00.js': 'console.log("app")',
    '/assets/index-At2By14n.css': 'body{}',
  };

  it('caches the shell and its hashed assets at install', async () => {
    const sw = loadServiceWorker(files);
    await sw.install();
    expect([...sw.stores.get('pnm-shell-v1')!.keys()]).toEqual([`${ORIGIN}/`]);
    expect([...sw.stores.get('pnm-assets-v1')!.keys()].sort()).toEqual([
      `${ORIGIN}/assets/index-At2By14n.css`,
      `${ORIGIN}/assets/index-DZvdjp00.js`,
    ]);
  });

  it('opens offline after a single online launch', async () => {
    const sw = loadServiceWorker(files);
    await sw.install();
    sw.setOnline(false);
    const shell = await sw.fetch('/', 'navigate');
    expect(await shell!.text()).toContain('/assets/index-DZvdjp00.js');
    const script = await sw.fetch('/assets/index-DZvdjp00.js');
    expect(await script!.text()).toBe('console.log("app")');
  });

  it('still installs when the shell cannot be fetched', async () => {
    const sw = loadServiceWorker({});
    await expect(sw.install()).resolves.toBeUndefined();
    expect(sw.stores.get('pnm-assets-v1')).toBeUndefined();
  });

  it('never answers /api/* from the service worker', async () => {
    const sw = loadServiceWorker(files);
    await sw.install();
    expect(await sw.fetch('/api/parking/current')).toBeUndefined();
  });
});
