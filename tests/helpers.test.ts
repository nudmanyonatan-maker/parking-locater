// Worker helpers: constant-time token comparison and the geocoder chain.

import { describe, expect, it, vi } from 'vitest';
import { constantTimeEqual } from '../worker/auth';
import { geocodeHome } from '../worker/geocode';

describe('constantTimeEqual', () => {
  it('compares whole strings', () => {
    expect(constantTimeEqual('secret-token-123', 'secret-token-123')).toBe(true);
    expect(constantTimeEqual('secret-token-123', 'secret-token-124')).toBe(false);
    expect(constantTimeEqual('secret-token-123', 'secret-token-12')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('é', 'e')).toBe(false);
  });
});

describe('geocodeHome', () => {
  const address = '403 Audubon Ave, New York, NY 10033';

  it('uses NYC GeoSearch first', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ features: [{ geometry: { coordinates: [-73.930153, 40.851304] } }] }));
    const home = await geocodeHome(address, fetchImpl);
    expect(home).toMatchObject({ address, lat: 40.851304, lon: -73.930153, source: 'nyc-geosearch' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Census geocoder, then Nominatim, then gives up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const census = { result: { addressMatches: [{ coordinates: { x: -73.9304, y: 40.8512 } }] } };
    const viaCensus = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('census.gov') ? Response.json(census) : new Response('down', { status: 500 }),
    );
    expect(await geocodeHome(address, viaCensus)).toMatchObject({ lat: 40.8512, lon: -73.9304, source: 'us-census' });

    const viaNominatim = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes('nominatim')) return Response.json({ features: [] });
      expect(new Headers(init?.headers).get('User-Agent')).toMatch(/ParkNearMe/);
      return Response.json([{ lat: '40.8513025', lon: '-73.9301574' }]);
    });
    expect(await geocodeHome(address, viaNominatim)).toMatchObject({ lat: 40.8513025, lon: -73.9301574, source: 'nominatim' });

    // A match outside NYC is treated as a failure.
    const wrongCity = vi.fn(async () => Response.json([{ lat: '51.5', lon: '-0.12' }]));
    expect(await geocodeHome(address, wrongCity)).toBeNull();
    vi.restoreAllMocks();
  });
});
