import { describe, expect, it } from 'vitest';
import { FRESHNESS, formatAge, frameFreshness, isDetectionCurrent, nextFrameState, secondsSince } from '../shared/freshness';

const now = new Date('2026-10-07T12:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

describe('frameFreshness', () => {
  const base = { catalogOnline: true, lastFetchedAt: ago(5), lastChangedAt: ago(5), consecutiveFailures: 0 };

  it('is LIVE when frames keep changing', () => {
    expect(frameFreshness(base, now)).toBe('live');
  });
  it('is STALE when the frame bytes have not changed for too long', () => {
    expect(frameFreshness({ ...base, lastChangedAt: ago(FRESHNESS.frozenAfterSeconds + 1) }, now)).toBe('stale');
  });
  it('is STALE when the EXIF capture time is old even though bytes change', () => {
    expect(frameFreshness({ ...base, lastCaptureAt: ago(FRESHNESS.exifStaleAfterSeconds + 10) }, now)).toBe('stale');
    expect(frameFreshness({ ...base, lastCaptureAt: ago(200) }, now)).toBe('live'); // modest clock drift tolerated
    expect(frameFreshness({ ...base, lastCaptureAt: ago(6) }, now)).toBe('live');
  });
  it('is OFFLINE when the catalog says so or fetches keep failing', () => {
    expect(frameFreshness({ ...base, catalogOnline: false }, now)).toBe('offline');
    expect(frameFreshness({ ...base, consecutiveFailures: FRESHNESS.offlineAfterFailures }, now)).toBe('offline');
  });
  it('is UNKNOWN when never fetched or not fetched recently', () => {
    expect(frameFreshness({ ...base, lastFetchedAt: null, lastChangedAt: null }, now)).toBe('unknown');
    expect(frameFreshness({ ...base, lastFetchedAt: ago(FRESHNESS.unknownAfterSeconds + 1) }, now)).toBe('unknown');
  });
});

describe('nextFrameState', () => {
  const prev = { lastHash: 'aaa', lastChangedAt: ago(30), consecutiveFailures: 0 };

  it('records a change when the hash differs', () => {
    expect(nextFrameState(prev, 'bbb', ago(0))).toMatchObject({ lastHash: 'bbb', lastChangedAt: ago(0), consecutiveFailures: 0 });
  });
  it('keeps lastChangedAt when the frame is identical (possible freeze)', () => {
    expect(nextFrameState(prev, 'aaa', ago(0)).lastChangedAt).toBe(ago(30));
  });
  it('counts failures without losing the last good hash', () => {
    const s = nextFrameState(prev, null, ago(0), 'timeout');
    expect(s).toMatchObject({ lastHash: 'aaa', consecutiveFailures: 1, lastError: 'timeout' });
  });
});

describe('isDetectionCurrent', () => {
  it('requires a live frame and a recent timestamp', () => {
    expect(isDetectionCurrent({ timestamp: ago(30), freshness: 'live' }, 300, now)).toBe(true);
    expect(isDetectionCurrent({ timestamp: ago(301), freshness: 'live' }, 300, now)).toBe(false);
    expect(isDetectionCurrent({ timestamp: ago(30), freshness: 'stale' }, 300, now)).toBe(false);
    expect(isDetectionCurrent(null, 300, now)).toBe(false);
  });
});

describe('formatting', () => {
  it('formats ages for humans', () => {
    expect(formatAge(null)).toBe('never');
    expect(formatAge(2)).toBe('just now');
    expect(formatAge(18)).toBe('18 sec ago');
    expect(formatAge(185)).toBe('3 min ago');
    expect(formatAge(7300)).toBe('2 hr ago');
  });
  it('computes seconds since', () => {
    expect(secondsSince(ago(42), now)).toBe(42);
    expect(secondsSince(null, now)).toBeNull();
    expect(secondsSince('garbage', now)).toBeNull();
  });
});
