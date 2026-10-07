// Street cleaning (alternate side parking) from NYC DOT broom-symbol signs.
//
// Data: src/data/street-cleaning.json, made by scripts/fetch_street_cleaning.py
// from NYC Open Data (nfid-uabd): block faces (street, cross streets, side)
// with their sign texts and each sign's position. This file parses the sign
// texts ("NO PARKING (SANITATION BROOM SYMBOL) FRIDAY 11:30AM-1PM"), works out
// the next cleaning in New York time, and finds which block face a car is on.
// Rules are suspended on legal holidays; we can't know that from the signs.

import { zonedTimeToUtc } from './jpeg';

export type Side = 'N' | 'S' | 'E' | 'W';

export interface CleaningFace {
  id: string;
  street: string;
  from: string;
  to: string;
  side: Side | string;
  rules: string[];
  /** Each sign: [lat, lon, index into rules]. */
  points: [number, number, number][];
}

export interface CleaningData {
  source: string;
  generatedAt: string;
  faces: CleaningFace[];
}

/** One "no parking" window: on these weekdays (0 = Sunday), from start to end minutes after midnight. */
export interface CleaningWindow {
  days: number[];
  start: number;
  end: number;
}

const DAY_WORDS: [RegExp, number][] = [
  [/^SUN(DAY)?$/, 0],
  [/^MON(DAY)?$/, 1],
  [/^TUE(S|SDAY)?$/, 2],
  [/^WED(NESDAY)?$/, 3],
  [/^THU(R|RS|RSDAY)?$/, 4],
  [/^FRI(DAY)?$/, 5],
  [/^SAT(URDAY)?$/, 6],
];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const dayOf = (word: string) => DAY_WORDS.find(([re]) => re.test(word))?.[1] ?? null;

/** "8", "8:30", "MIDNIGHT", "NOON" + optional AM/PM -> minutes, or null. Hour 12 handled like a clock. */
function clock(text: string, meridiem: string | null): number | null {
  if (text === 'MIDNIGHT') return 0;
  if (text === 'NOON') return 12 * 60;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 12 || min > 59) return null;
  if (meridiem === 'AM' && h === 12) h = 0;
  if (meridiem === 'PM' && h !== 12) h += 12;
  return h * 60 + min;
}

/** Parse one broom sign. Returns null for text we don't understand (never guess). */
export function parseCleaningRule(text: string): CleaningWindow | null {
  const t = text.toUpperCase().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ');
  const time = /(\d{1,2}(?::\d{2})?|MIDNIGHT|NOON)\s*(AM|PM)?\s*-\s*(\d{1,2}(?::\d{2})?|MIDNIGHT|NOON)\s*(AM|PM)?/.exec(t);
  if (!time) return null;
  const endMer = time[4] ?? null;
  const end = clock(time[3]!, endMer);
  // "8:30-10AM": the start takes the end's AM/PM unless that would put it after the end ("11:30-1PM" is 11:30 AM).
  let start = clock(time[1]!, time[2] ?? endMer);
  if (start !== null && end !== null && !time[2] && endMer === 'PM' && start > end) start = clock(time[1]!, 'AM');
  if (start === null || end === null || end <= start) return null;

  const rest = (t.slice(0, time.index) + ' ' + t.slice(time.index + time[0].length)).replace(/NO PARKING|SANITATION|BROOM|SYMBOL/g, ' ');
  const words = rest.split(/[\s,&]+/).filter(Boolean);
  let days: number[] = [];
  const except = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === 'EXCEPT') {
      for (let j = i + 1; j < words.length && dayOf(words[j]!) !== null; j++) except.add(dayOf(words[j]!)!);
      break;
    }
    const d = dayOf(w);
    if (d === null) continue;
    // "MON THRU FRI" / "MON-FRI"
    if ((words[i + 1] === 'THRU' || words[i + 1] === 'TO') && dayOf(words[i + 2] ?? '') !== null) {
      const to = dayOf(words[i + 2]!)!;
      for (let k = d; ; k = (k + 1) % 7) {
        days.push(k);
        if (k === to) break;
      }
      i += 2;
    } else {
      days.push(d);
    }
  }
  if (!days.length) days = [...ALL_DAYS];
  days = [...new Set(days)].filter((d) => !except.has(d)).sort((a, b) => a - b);
  return days.length ? { days, start, end } : null;
}

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clockText(min: number, withMeridiem: boolean): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${withMeridiem ? (h < 12 ? ' AM' : ' PM') : ''}`;
}

function daysText(days: number[]): string {
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Daily';
  if (key === '1,2,3,4,5,6') return 'Mon–Sat';
  if (key === '1,2,3,4,5') return 'Mon–Fri';
  return days.map((d) => SHORT_DAY[d]).join(' & ');
}

/** "Fri 11:30 AM–1 PM", "Mon–Sat 8–8:30 AM". */
export function windowText(w: CleaningWindow): string {
  const sameHalf = w.start < 720 === w.end <= 720;
  return `${daysText(w.days)} ${clockText(w.start, !sameHalf)}–${clockText(w.end, true)}`;
}

// ---- Time in New York ---------------------------------------------------

const nyDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** UTC ms for a New York wall-clock time on the NY calendar day `dayOffset` days after the NY date of `nowMs`. */
function nyTime(nowMs: number, dayOffset: number, minutes: number): { ms: number; weekday: number } {
  const p = Object.fromEntries(nyDate.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  // Step whole calendar days (not 24 h), so DST changes can't skip or repeat a date.
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + dayOffset));
  const pad = (n: number) => String(n).padStart(2, '0');
  const wall = `${day.getUTCFullYear()}:${pad(day.getUTCMonth() + 1)}:${pad(day.getUTCDate())} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
  const iso = zonedTimeToUtc(wall);
  return { ms: iso ? Date.parse(iso) : NaN, weekday: day.getUTCDay() };
}

export interface NextCleaning {
  start: number;
  end: number;
  /** Cleaning is happening right now (no parking until `end`). */
  active: boolean;
  window: CleaningWindow;
}

/** The current or next cleaning across `windows`, looking up to 8 days ahead. */
export function nextCleaning(windows: CleaningWindow[], nowMs: number): NextCleaning | null {
  let best: NextCleaning | null = null;
  for (let offset = -1; offset <= 8; offset++) {
    for (const w of windows) {
      const s = nyTime(nowMs, offset, w.start);
      if (!w.days.includes(s.weekday)) continue;
      const e = nyTime(nowMs, offset, w.end);
      if (!Number.isFinite(s.ms) || e.ms <= nowMs) continue;
      if (!best || s.ms < best.start) best = { start: s.ms, end: e.ms, active: s.ms <= nowMs, window: w };
    }
    if (best && best.start <= nyTime(nowMs, offset + 1, 0).ms) break;
  }
  return best;
}

// ---- Labels ---------------------------------------------------------------

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** "AUDUBON AVENUE" -> "Audubon Ave", "WEST 185 STREET" -> "W 185th St". */
export function prettyStreet(name: string): string {
  const s = name
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bSAINT\b/, 'ST')
    .replace(/\b(WEST|EAST) (\d+) STREET\b/, (_m, dir: string, n: string) => `${dir[0]} ${ordinal(Number(n))} St`)
    .replace(/\bAVENUE\b/, 'Ave')
    .replace(/\bSTREET\b/, 'St')
    .replace(/\bTERRACE\b/, 'Ter')
    .replace(/\bPLACE\b/, 'Pl')
    .replace(/\bROAD\b/, 'Rd');
  return s.replace(/\b([A-Z])([A-Z]+)\b/g, (_m, a: string, b: string) => a + b.toLowerCase());
}

/** Cross streets as short as possible: "185th–186th", "Audubon–St Nicholas". */
export function betweenText(face: Pick<CleaningFace, 'from' | 'to'>): string {
  const short = (x: string) => prettyStreet(x).replace(/^[WE] (\d+\w\w) St$/, '$1').replace(/ (Ave|St|Ter|Pl|Rd)$/, '');
  return `${short(face.from)}–${short(face.to)}`;
}

const SIDE_WORD: Record<string, string> = { N: 'north', S: 'south', E: 'east', W: 'west' };

/** "Audubon Ave, east side (185th–186th)". */
export function faceLabel(face: CleaningFace): string {
  return `${prettyStreet(face.street)}, ${SIDE_WORD[face.side] ?? face.side} side (${betweenText(face)})`;
}

export function sideWord(face: CleaningFace): string {
  return SIDE_WORD[face.side] ?? face.side;
}

/** Every parseable window on a face (all its signs). */
export function faceWindows(face: CleaningFace): CleaningWindow[] {
  return face.rules.map(parseCleaningRule).filter((w): w is CleaningWindow => w !== null);
}

// ---- Geometry ---------------------------------------------------------------

type LatLon = { lat: number; lon: number };
const M_PER_DEG_LAT = 111_132;

/** Local flat metres around `o` (fine at block scale). */
function xy(o: LatLon, p: LatLon): [number, number] {
  return [(p.lon - o.lon) * M_PER_DEG_LAT * Math.cos((o.lat * Math.PI) / 180), (p.lat - o.lat) * M_PER_DEG_LAT];
}

/** Distance (m) from `p` to the line through a face's two farthest-apart signs (or to its only sign). */
export function distanceToFace(face: CleaningFace, p: LatLon): number {
  const pts = face.points.map(([lat, lon]) => xy(p, { lat, lon }));
  if (!pts.length) return Infinity;
  let a = pts[0]!;
  let b = pts[0]!;
  let far = -1;
  for (const u of pts) for (const v of pts) {
    const d = Math.hypot(u[0] - v[0], u[1] - v[1]);
    if (d > far) [a, b, far] = [u, v, d];
  }
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2)) : 0;
  return Math.hypot(a[0] + t * dx, a[1] + t * dy);
}

/** Rule of the sign nearest `p` on this face (long blocks can change rules partway). */
export function windowNear(face: CleaningFace, p: LatLon): CleaningWindow | null {
  let best: [number, number] | null = null;
  for (const [lat, lon, rule] of face.points) {
    const [x, y] = xy(p, { lat, lon });
    const d = Math.hypot(x, y);
    if (!best || d < best[0]) best = [d, rule];
  }
  return best ? parseCleaningRule(face.rules[best[1]] ?? '') : null;
}

export interface BlockMatch {
  /** The block face the point is most likely on. */
  face: CleaningFace;
  /** Other sides of the same block, nearest first (GPS can't always tell sides apart). */
  others: CleaningFace[];
  distanceM: number;
}

/** Which block face a parked car is on, or null if no broom signs within `maxM`. */
export function findBlock(data: CleaningData, p: LatLon, maxM = 45): BlockMatch | null {
  const ranked = data.faces.map((face) => ({ face, d: distanceToFace(face, p) })).sort((a, b) => a.d - b.d);
  const top = ranked[0];
  if (!top || top.d > maxM) return null;
  const sameBlock = (f: CleaningFace) => f.street === top.face.street && f.from === top.face.from && f.to === top.face.to && f.id !== top.face.id;
  return { face: top.face, others: ranked.filter((r) => sameBlock(r.face)).map((r) => r.face), distanceM: top.d };
}

/** Faces within `maxM` of a point, nearest first. */
export function facesNear(data: CleaningData, p: LatLon, maxM: number): { face: CleaningFace; distanceM: number }[] {
  return data.faces
    .map((face) => ({ face, distanceM: distanceToFace(face, p) }))
    .filter((f) => f.distanceM <= maxM)
    .sort((a, b) => a.distanceM - b.distanceM);
}
