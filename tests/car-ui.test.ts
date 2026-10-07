import { describe, expect, it } from 'vitest';
import { cleaningAt, cleaningNear, formatDistance, haversineMeters, longestFree, moveByFor, moveByStatus, walkUrl, whenText } from '../src/lib/car';

const HOME = { lat: 40.851304, lng: -73.930153 }; // 403 Audubon Ave
const wed10 = Date.parse('2026-10-07T14:00:00Z'); // Wed 10:00 AM in New York

describe('car helpers', () => {
  it('formats distances and the walking link', () => {
    expect(formatDistance(100)).toBe('328 ft');
    expect(formatDistance(800)).toBe('0.5 mi');
    expect(haversineMeters({ lat: 40.85, lng: -73.93 }, { lat: 40.851, lng: -73.93 })).toBeCloseTo(111.2, 0);
    expect(walkUrl({ lat: 40.85, lng: -73.93 })).toBe('https://maps.apple.com/?daddr=40.85,-73.93&dirflg=w');
  });
  it('says when in New York time', () => {
    expect(whenText(Date.parse('2026-10-07T15:30:00Z'), wed10)).toBe('Today 11:30 AM');
    expect(whenText(Date.parse('2026-10-08T12:00:00Z'), wed10)).toBe('Tomorrow 8 AM');
    expect(whenText(Date.parse('2026-10-09T15:30:00Z'), wed10)).toBe('Fri 11:30 AM');
    expect(moveByStatus({ moveBy: wed10 + 20 * 60_000 }, wed10)).toEqual({ text: 'Move by Today 10:20 AM', tone: 'soon' });
    expect(moveByStatus({ moveBy: wed10 - 60_000 }, wed10)?.tone).toBe('late');
    expect(moveByStatus({ moveBy: null }, wed10)).toBeNull();
  });
});

describe('street cleaning for the car', () => {
  it('finds the block, its schedule and the move-by time', () => {
    const c = cleaningAt(HOME, wed10)!;
    expect(c.label).toMatch(/^Audubon Ave, (east|west) side \(185th–186th\)$/);
    expect(c.schedule).toMatch(/^(Thu|Fri) 11:30 AM–1 PM$/);
    expect(c.others).toHaveLength(1);
    const { moveBy, faceId } = moveByFor(HOME, wed10);
    expect(faceId).toBe(c.face.id);
    expect(moveBy).toBe(c.next!.start);
  });
  it('switches sides when asked', () => {
    const c = cleaningAt(HOME, wed10)!;
    const other = cleaningAt(HOME, wed10, c.others[0]!.id)!;
    expect(other.face.id).toBe(c.others[0]!.id);
    expect(other.schedule).not.toBe(c.schedule);
  });
  it('gives up far from any cleaning sign', () => {
    expect(cleaningAt({ lat: 40.78, lng: -73.97 }, wed10)).toBeNull();
    expect(moveByFor({ lat: 40.78, lng: -73.97 }, wed10)).toEqual({ moveBy: null, faceId: null });
  });
  it('lists the sides around home and the one free the longest', () => {
    const rows = cleaningNear(HOME, wed10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.label.startsWith('Audubon Ave'))).toBe(true);
    const best = longestFree(rows)!;
    for (const r of rows) if (r.next && !r.next.active) expect(best.next!.start).toBeGreaterThanOrEqual(r.next.start);
  });
});
