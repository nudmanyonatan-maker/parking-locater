// TMC client: catalog parsing, JPEG validation, error mapping.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameFreshness } from '../shared/freshness';
import type { Env } from '../worker/env';
import { fetchCatalog, fetchFrame, frameFromBytes, parseCatalogEntry, TmcError } from '../worker/tmc';
import { FRAME, FRAME_HASH, FRAME_WITH_EXIF } from './helpers/harness';

const env = { TMC_BASE_URL: 'https://tmc.test/api/cameras/' } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(respond: (url: string) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('catalog parsing', () => {
  it('reads string flags and numeric strings, drops unusable rows', () => {
    expect(parseCatalogEntry({ id: 'abc-1', name: ' Audobon Ave @ W 181 ST ', latitude: 40.8, longitude: '-73.9', area: 'Manhattan', isOnline: 'false' })).toEqual({
      id: 'abc-1',
      name: 'Audobon Ave @ W 181 ST',
      area: 'Manhattan',
      lat: 40.8,
      lon: -73.9,
      isOnline: false,
    });
    expect(parseCatalogEntry({ id: 'abc-2', latitude: 1, longitude: 2, isOnline: 'true' })).toMatchObject({ name: 'abc-2', area: null, isOnline: true });
    expect(parseCatalogEntry({ id: '../x', latitude: 1, longitude: 2 })).toBeNull();
    expect(parseCatalogEntry({ id: 'a', latitude: 'n/a', longitude: 2 })).toBeNull();
    expect(parseCatalogEntry({ id: 'a', latitude: 91, longitude: 2 })).toBeNull();
    expect(parseCatalogEntry('nope')).toBeNull();
  });

  it('fetches the catalog with cache busting and rejects junk', async () => {
    const mock = stubFetch(() => Response.json([{ id: 'a', latitude: 40.8, longitude: -73.9, isOnline: 'true' }, { bogus: true }]));
    expect(await fetchCatalog(env)).toHaveLength(1);
    expect(String(mock.mock.calls[0]![0])).toMatch(/^https:\/\/tmc\.test\/api\/cameras\/\?t=\d+$/);

    stubFetch(() => Response.json({ error: 'nope' }));
    await expect(fetchCatalog(env)).rejects.toMatchObject({ code: 'bad_response' });
    stubFetch(() => new Response('<html>', { status: 200 }));
    await expect(fetchCatalog(env)).rejects.toMatchObject({ code: 'bad_response' });
    stubFetch(() => new Response('down', { status: 503 }));
    await expect(fetchCatalog(env)).rejects.toMatchObject({ code: 'http_error', status: 503 });
  });
});

describe('frames', () => {
  it('validates and hashes frames, reading size and EXIF capture time', async () => {
    const frame = await frameFromBytes(FRAME_WITH_EXIF.slice(), '2026-10-07T04:26:31.000Z');
    expect(frame).toMatchObject({
      width: 352,
      height: 240,
      fetchedAt: '2026-10-07T04:26:31.000Z',
      capturedAt: '2026-10-07T04:26:29.000Z', // EXIF 00:26:29 New York time
    });
    await expect(frameFromBytes(FRAME.slice(0, 1000), 'x')).rejects.toMatchObject({ code: 'bad_image' });
    await expect(frameFromBytes(new Uint8Array(5000).fill(7), 'x')).rejects.toMatchObject({ code: 'bad_image' });
  });

  it('keeps EXIF frames live during the repeated hour when clocks fall back', async () => {
    // The fixture's EXIF time rewritten to 01:30 New York time on 2026-11-01, captured in the EST hour (06:30Z).
    const bytes = FRAME_WITH_EXIF.slice();
    const at = Buffer.from(bytes).indexOf('2026:10:07 00:26:29');
    expect(at).toBeGreaterThan(0);
    bytes.set(new TextEncoder().encode('2026:11:01 01:30:00'), at);
    const fetchedAt = '2026-11-01T06:30:01.000Z';
    const frame = await frameFromBytes(bytes, fetchedAt);
    expect(frame.capturedAt).toBe('2026-11-01T06:30:00.000Z');
    const observed = { catalogOnline: true, lastFetchedAt: fetchedAt, lastChangedAt: fetchedAt, consecutiveFailures: 0, lastCaptureAt: frame.capturedAt };
    expect(frameFreshness(observed, new Date(fetchedAt))).toBe('live');
  });

  it('recognizes the "camera being serviced" PNG placeholder', async () => {
    const png = new Uint8Array(6000);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(frameFromBytes(png, 'x')).rejects.toMatchObject({ code: 'out_of_service' });
  });

  it('maps fetch failures to TmcError codes', async () => {
    stubFetch(() => new Response(FRAME.slice()));
    expect((await fetchFrame(env, 'cam-1')).hash).toBe(FRAME_HASH);

    stubFetch(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    await expect(fetchFrame(env, 'cam-1')).rejects.toMatchObject({ code: 'timeout', status: 0 });
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchFrame(env, 'cam-1')).rejects.toMatchObject({ code: 'network' });
    stubFetch(() => new Response('', { status: 404 }));
    await expect(fetchFrame(env, 'cam-1')).rejects.toMatchObject({ code: 'http_error', status: 404 });
    stubFetch(() => new Response('x', { headers: { 'Content-Length': String(4 * 1024 * 1024) } }));
    await expect(fetchFrame(env, 'cam-1')).rejects.toMatchObject({ code: 'bad_image' });
    await expect(fetchFrame(env, '../../etc')).rejects.toBeInstanceOf(TmcError);
  });
});
