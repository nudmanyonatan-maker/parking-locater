import { describe, expect, it, vi } from 'vitest';
import { haversineMiles } from '../shared/geo';
import { candidateMarkerPositions, FAN_OUT_M, onMarkerActivate } from '../src/components/mapMarkers';
import { cameraMarkerStatus } from '../src/lib/detection';

const M_PER_MI = 1609.344;

describe('parking marker positions', () => {
  const anchor = { lat: 40.8494, lon: -73.9356 };
  it('fans out several gaps that share one lane anchor', () => {
    const pos = candidateMarkerPositions([
      { ...anchor, approximateLocation: false },
      { ...anchor, approximateLocation: false },
      { ...anchor, approximateLocation: false },
    ]);
    expect(pos[0]).toEqual({ ...anchor, moved: false });
    expect(pos[1]!.moved).toBe(true);
    expect(pos[2]!.moved).toBe(true);
    const keys = new Set(pos.map((p) => `${p.lat},${p.lon}`));
    expect(keys.size).toBe(3);
    expect(haversineMiles(anchor, pos[1]!) * M_PER_MI).toBeCloseTo(FAN_OUT_M, 0);
  });
  it('keeps lone anchored candidates in place and pushes approximate ones off the camera', () => {
    const other = { lat: 40.851, lon: -73.934 };
    const pos = candidateMarkerPositions([
      { ...anchor, approximateLocation: false },
      { ...other, approximateLocation: true },
      { ...other, approximateLocation: true },
    ]);
    expect(pos[0]).toEqual({ ...anchor, moved: false });
    expect(pos[1]!.moved && pos[2]!.moved).toBe(true);
    expect(pos[1]).not.toEqual(pos[2]);
  });
});

describe('marker activation', () => {
  function fakeMarker() {
    const handlers = new Map<string, (e: unknown) => void>();
    return { handlers, marker: { on: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn) } };
  }
  const key = (k: string) => ({ originalEvent: { key: k, preventDefault: vi.fn() } });

  it('activates on click, Enter and Space only', () => {
    const { handlers, marker } = fakeMarker();
    const activate = vi.fn();
    onMarkerActivate(marker as never, activate);
    handlers.get('click')!({});
    expect(activate).toHaveBeenCalledTimes(1);
    const enter = key('Enter');
    handlers.get('keydown')!(enter);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(enter.originalEvent.preventDefault).toHaveBeenCalled();
    handlers.get('keydown')!(key(' '));
    expect(activate).toHaveBeenCalledTimes(3);
    const tab = key('Tab');
    handlers.get('keydown')!(tab);
    expect(activate).toHaveBeenCalledTimes(3);
    expect(tab.originalEvent.preventDefault).not.toHaveBeenCalled();
  });
});

describe('camera marker status', () => {
  const nowMs = Date.parse('2026-10-07T12:00:00Z');
  const latest = (secondsAgo: number, extra = {}) =>
    ({ latest: { timestamp: new Date(nowMs - secondsAgo * 1000).toISOString(), freshness: 'live', status: 'likely_available', ...extra } }) as never;

  it('shows the parking colour only while the result is current', () => {
    expect(cameraMarkerStatus(latest(30), true, nowMs)).toBe('likely_available');
    expect(cameraMarkerStatus(latest(20 * 60), true, nowMs)).toBe('unknown');
    expect(cameraMarkerStatus(latest(30, { freshness: 'stale' }), true, nowMs)).toBe('unknown');
    expect(cameraMarkerStatus(latest(200), true, nowMs, 120)).toBe('unknown');
  });
  it('has no dot for unchecked or unwatched cameras', () => {
    expect(cameraMarkerStatus({ latest: null }, true, nowMs)).toBeNull();
    expect(cameraMarkerStatus(latest(30), false, nowMs)).toBeNull();
  });
});
