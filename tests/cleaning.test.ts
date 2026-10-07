import { describe, expect, it } from 'vitest';
import {
  faceLabel,
  faceWindows,
  findBlock,
  nextCleaning,
  parseCleaningRule,
  prettyStreet,
  windowNear,
  windowText,
  type CleaningData,
} from '../shared/cleaning';
import data from '../src/data/street-cleaning.json';

const streetCleaning = data as unknown as CleaningData;
const HOME = { lat: 40.851304, lon: -73.930153 }; // 403 Audubon Ave

describe('parseCleaningRule', () => {
  it('reads one day, several days, and "except Sunday"', () => {
    expect(parseCleaningRule('NO PARKING (SANITATION BROOM SYMBOL) FRIDAY 11:30AM-1PM')).toEqual({ days: [5], start: 690, end: 780 });
    expect(parseCleaningRule('NO PARKING (SANITATION BROOM SYMBOL) MONDAY THURSDAY 7:30AM-8AM')).toEqual({ days: [1, 4], start: 450, end: 480 });
    expect(parseCleaningRule('NO PARKING (SANITATION BROOM SYMBOL) 8AM-8:30AM EXCEPT SUNDAY')).toEqual({ days: [1, 2, 3, 4, 5, 6], start: 480, end: 510 });
  });
  it('handles shared AM/PM, ranges and odd forms', () => {
    expect(parseCleaningRule('NO PARKING (SANITATION BROOM SYMBOL) TUES & FRI 8:30-10AM')).toEqual({ days: [2, 5], start: 510, end: 600 });
    expect(parseCleaningRule('NO PARKING (SANITATION BROOM SYMBOL) MON THRU FRI 11:30-1PM')).toEqual({ days: [1, 2, 3, 4, 5], start: 690, end: 780 });
    expect(parseCleaningRule('NO PARKING (SANITATION BROOM SYMBOL) MIDNIGHT-3AM')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 180 });
    expect(parseCleaningRule('NO PARKING ANYTIME')).toBeNull();
  });
  it('understands every rule near home', () => {
    const rules = [...new Set(streetCleaning.faces.flatMap((f) => f.rules))];
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) expect(parseCleaningRule(r), r).not.toBeNull();
  });
  it('writes short schedules', () => {
    expect(windowText({ days: [5], start: 690, end: 780 })).toBe('Fri 11:30 AM–1 PM');
    expect(windowText({ days: [1, 2, 3, 4, 5, 6], start: 480, end: 510 })).toBe('Mon–Sat 8–8:30 AM');
    expect(windowText({ days: [1, 4], start: 450, end: 480 })).toBe('Mon & Thu 7:30–8 AM');
  });
});

describe('nextCleaning (New York time)', () => {
  const fri = { days: [5], start: 690, end: 780 };
  // 2026-10-07 is a Wednesday; 10:00 EDT = 14:00 UTC.
  const wed10 = Date.parse('2026-10-07T14:00:00Z');
  it('finds the next window days ahead', () => {
    const n = nextCleaning([fri], wed10)!;
    expect(new Date(n.start).toISOString()).toBe('2026-10-09T15:30:00.000Z');
    expect(new Date(n.end).toISOString()).toBe('2026-10-09T17:00:00.000Z');
    expect(n.active).toBe(false);
  });
  it('is active during the window and moves on after it', () => {
    const during = Date.parse('2026-10-09T16:00:00Z');
    expect(nextCleaning([fri], during)).toMatchObject({ active: true, end: Date.parse('2026-10-09T17:00:00Z') });
    const after = Date.parse('2026-10-09T17:30:00Z');
    expect(new Date(nextCleaning([fri], after)!.start).toISOString()).toBe('2026-10-16T15:30:00.000Z');
  });
  it('picks the earliest of several windows and handles the DST change', () => {
    const daily = { days: [1, 2, 3, 4, 5, 6], start: 480, end: 510 };
    expect(new Date(nextCleaning([fri, daily], wed10)!.start).toISOString()).toBe('2026-10-08T12:00:00.000Z');
    // Clocks fall back on Sun 2026-11-01: Monday 8 AM is then 13:00 UTC.
    const satNight = Date.parse('2026-11-01T03:00:00Z');
    expect(new Date(nextCleaning([daily], satNight)!.start).toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });
});

describe('block faces near home', () => {
  it('finds the home block on Audubon Ave and its other side', () => {
    const match = findBlock(streetCleaning, HOME)!;
    expect(match.face.street).toBe('AUDUBON AVENUE');
    expect([match.face.from, match.face.to]).toEqual(['WEST 185 STREET', 'WEST 186 STREET']);
    expect(match.others.map((f) => f.side)).toEqual([match.face.side === 'E' ? 'W' : 'E']);
    expect(faceLabel(match.face)).toMatch(/^Audubon Ave, (east|west) side \(185th–186th\)$/);
  });
  it('uses the nearest sign rule and gives up far from any sign', () => {
    const match = findBlock(streetCleaning, HOME)!;
    expect(windowNear(match.face, HOME)).toEqual(faceWindows(match.face)[0]);
    expect(findBlock(streetCleaning, { lat: 40.78, lon: -73.97 })).toBeNull();
  });
  it('prettifies street names', () => {
    expect(prettyStreet('WEST 185 STREET')).toBe('W 185th St');
    expect(prettyStreet('ST NICHOLAS AVENUE')).toBe('St Nicholas Ave');
    expect(prettyStreet('SAINT NICHOLAS AVENUE')).toBe('St Nicholas Ave');
    expect(prettyStreet('WADSWORTH TERRACE')).toBe('Wadsworth Ter');
  });
});
