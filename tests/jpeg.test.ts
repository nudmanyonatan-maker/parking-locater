import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectJpeg, isPng, zonedTimeToUtc } from '../shared/jpeg';

const frame = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));

describe('inspectJpeg', () => {
  it('reads size and EXIF capture time from a real AXIS frame', () => {
    expect(inspectJpeg(frame('audubon-181-0.jpg'))).toEqual({ width: 352, height: 240, exifDateTime: '2026:10:07 00:26:29' });
  });
  it('reads size from a frame without EXIF', () => {
    expect(inspectJpeg(frame('cbe-720.jpg'))).toEqual({ width: 720, height: 480, exifDateTime: null });
  });
  it('rejects non-JPEG data (e.g. the PNG "being serviced" placeholder) and truncated files', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(isPng(png)).toBe(true);
    expect(inspectJpeg(png)).toBeNull();
    expect(inspectJpeg(frame('audubon-181-0.jpg').subarray(0, 40))).toBeNull();
  });
});

describe('zonedTimeToUtc', () => {
  it('converts NYC wall-clock time (EDT and EST) to UTC', () => {
    expect(zonedTimeToUtc('2026:10:07 00:26:29')).toBe('2026-10-07T04:26:29.000Z');
    expect(zonedTimeToUtc('2026:12:01 08:00:00')).toBe('2026-12-01T13:00:00.000Z');
  });
  it('resolves the repeated hour when clocks fall back to the occurrence nearest the fetch time', () => {
    // 2026-11-01 01:30 happens twice in New York: 05:30Z (EDT) and 06:30Z (EST).
    const near = (iso: string) => Date.parse(iso);
    expect(zonedTimeToUtc('2026:11:01 01:30:00', 'America/New_York', near('2026-11-01T06:30:01Z'))).toBe('2026-11-01T06:30:00.000Z');
    expect(zonedTimeToUtc('2026:11:01 01:30:00', 'America/New_York', near('2026-11-01T05:30:01Z'))).toBe('2026-11-01T05:30:00.000Z');
    expect(zonedTimeToUtc('2026:11:01 01:30:00')).toBe('2026-11-01T05:30:00.000Z'); // no reference: first occurrence
    // Unambiguous times ignore the reference; the skipped spring-forward hour still converts.
    expect(zonedTimeToUtc('2026:11:01 02:00:00', 'America/New_York', near('2026-11-01T05:00:00Z'))).toBe('2026-11-01T07:00:00.000Z');
    expect(zonedTimeToUtc('2026:03:08 03:00:00')).toBe('2026-03-08T07:00:00.000Z');
    expect(zonedTimeToUtc('2026:03:08 02:30:00')).not.toBeNull();
  });
  it('rejects malformed input', () => {
    expect(zonedTimeToUtc('yesterday')).toBeNull();
  });
});
