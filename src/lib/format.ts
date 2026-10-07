// Display helpers: plain-English reasons, NYC clock times, status tones.

import type { CameraSummary, Freshness, ParkingStatus, SummaryState } from '../../shared/types';
import { prettyCameraName } from '../../shared/status';

export type Tone = 'green' | 'yellow' | 'red' | 'gray' | 'blue' | 'orange';

export const STATUS_TONE: Record<ParkingStatus, Tone> = {
  likely_available: 'green',
  possible: 'yellow',
  none: 'red',
  unknown: 'gray',
};

export const SUMMARY_TONE: Record<SummaryState, Tone> = {
  available: 'green',
  possible: 'yellow',
  none: 'red',
  unknown: 'gray',
};

export const FRESHNESS_TONE: Record<Freshness, Tone> = {
  live: 'blue',
  stale: 'orange',
  offline: 'gray',
  unknown: 'gray',
};

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  live: 'Live',
  stale: 'Stale',
  offline: 'Offline',
  unknown: 'Unknown',
};

const REASON_TEXT: Record<string, string> = {
  needs_calibration: 'Not calibrated yet',
  stale_frame: 'Camera image is frozen',
  frame_unavailable: 'Camera offline',
  detector_unavailable: 'Analysis unavailable',
  detector_error: 'Analysis failed',
  no_vehicles_detected: "Couldn't see any cars (dark or glare?)",
};

/** Plain-English text for a machine reason code (unknown codes are prettified). */
export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? reason.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const NY = 'America/New_York';
const clock = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' });
const clockSec = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'short', day: 'numeric' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' });

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "12:42 AM" in New York time. */
export function formatClock(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? clock.format(d) : '—';
}

/** "12:42:03 AM" in New York time. */
export function formatClockSeconds(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? clockSec.format(d) : '—';
}

/** "Oct 7" when the time is not today (NY), else null. */
export function dayIfNotToday(iso: string, nowMs: number): string | null {
  const d = parse(iso);
  if (!d) return null;
  return dayKey.format(d) === dayKey.format(new Date(nowMs)) ? null : dayFmt.format(d);
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

export function spotsText(n: number): string {
  if (n <= 0) return 'no spots';
  return `${n} possible ${n === 1 ? 'spot' : 'spots'}`;
}

/** Best human name for a camera: user's street label, else the prettified TMC name. */
export function cameraLabel(cam: Pick<CameraSummary, 'name'> & { preference?: { streetLabel: string | null } | null }): string {
  return cam.preference?.streetLabel?.trim() || prettyCameraName(cam.name);
}

/** Seconds between an ISO time and `nowMs` (never negative), or null. */
export function ageSeconds(iso: string | null | undefined, nowMs: number): number | null {
  const d = parse(iso);
  return d ? Math.max(0, Math.round((nowMs - d.getTime()) / 1000)) : null;
}
