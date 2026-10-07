// Minimal JPEG inspection without decoding pixels (cheap enough for the
// Workers Free plan's 10 ms CPU budget): size, EXIF capture time, and the
// NYC TMC "This camera is being serviced" placeholder.

export interface JpegInfo {
  width: number;
  height: number;
  /** EXIF DateTime as written by the camera ("YYYY:MM:DD HH:MM:SS", NYC local time), if present. */
  exifDateTime: string | null;
}

/** sha-256 of the 352x240 PNG TMC returns (HTTP 200, labelled image/jpeg) for cameras being serviced. */
export const TMC_SERVICED_PLACEHOLDER_SHA256 = '8cb2a34149523b8427f1fc4cfe4bf23ce21935c3e94e4b8e015b5b95cd9e21f4';

export function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
}

/** Parse SOF dimensions and EXIF DateTime. Returns null if this is not a usable JPEG. */
export function inspectJpeg(b: Uint8Array): JpegInfo | null {
  if (!isJpeg(b)) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let exifDateTime: string | null = null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = view.getUint16(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    if (marker === 0xe1 && !exifDateTime) exifDateTime = readExifDateTime(b, i + 4, len - 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(i + 5);
      const width = view.getUint16(i + 7);
      return width > 0 && height > 0 ? { width, height, exifDateTime } : null;
    }
    if (marker === 0xda) return null; // start of scan before any SOF
    i += 2 + len;
  }
  return null;
}

function readExifDateTime(b: Uint8Array, start: number, length: number): string | null {
  // "Exif\0\0" then a TIFF header.
  if (length < 14 || b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66) return null;
  const tiff = start + 6;
  const end = start + length;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return null;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);

  const findTag = (ifdOffset: number, tag: number): { type: number; count: number; valueOffset: number } | null => {
    const ifd = tiff + ifdOffset;
    if (ifd + 2 > end) return null;
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > end) return null;
      if (u16(e) === tag) return { type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8 };
    }
    return null;
  };
  const readAscii = (entry: { type: number; count: number; valueOffset: number } | null) => {
    if (!entry || entry.type !== 2 || entry.count < 19) return null;
    const at = entry.count > 4 ? tiff + u32(entry.valueOffset) : entry.valueOffset;
    if (at + 19 > end) return null;
    const s = String.fromCharCode(...b.subarray(at, at + 19));
    return /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s : null;
  };

  try {
    const ifd0 = u32(tiff + 4);
    const direct = readAscii(findTag(ifd0, 0x0132));
    if (direct) return direct;
    const exifPtr = findTag(ifd0, 0x8769);
    return exifPtr ? readAscii(findTag(u32(exifPtr.valueOffset), 0x9003)) : null;
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;

/**
 * Convert a wall-clock time in a time zone (default America/New_York, where the
 * cameras are) to a UTC ISO string. Handles DST via Intl. A wall time that
 * happens twice (the repeated hour when clocks fall back) resolves to the
 * occurrence closest to `nearMs` (e.g. when the frame was fetched), or to the
 * first occurrence without it.
 */
export function zonedTimeToUtc(exif: string, timeZone = 'America/New_York', nearMs?: number): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(exif);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - t;
  };
  // The offsets in force a day before and a day after (at most one transition in between);
  // each gives a candidate instant, valid when that offset really applies at it.
  const candidates = [...new Set([offsetAt(wall - DAY_MS), offsetAt(wall + DAY_MS)])]
    .map((offset) => wall - offset)
    .filter((t) => offsetAt(t) === wall - t)
    .sort((a, b) => a - b);
  let utc: number;
  if (candidates.length === 0) {
    // A wall time skipped when clocks spring forward: settle on the offset found by iterating.
    utc = wall - offsetAt(wall);
    utc = wall - offsetAt(utc);
  } else if (nearMs !== undefined && Number.isFinite(nearMs)) {
    utc = candidates.reduce((best, t) => (Math.abs(t - nearMs) < Math.abs(best - nearMs) ? t : best));
  } else {
    utc = candidates[0]!;
  }
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}
