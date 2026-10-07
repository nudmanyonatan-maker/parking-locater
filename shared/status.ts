// Turns per-camera results into the one-line answer on the main screen.

import type { ParkingCandidate, ParkingStatus, SummaryState } from './types';

export const STATUS_LABEL: Record<ParkingStatus, string> = {
  likely_available: 'Likely parking',
  possible: 'Possible parking',
  none: 'No visible parking',
  unknown: 'Unknown',
};

export function summarize(
  candidates: Pick<ParkingCandidate, 'spaces' | 'status'>[],
  watchedCurrent: number,
): { state: SummaryState; spots: number; headline: string } {
  const spots = candidates.reduce((s, c) => s + c.spaces, 0);
  if (candidates.some((c) => c.status === 'likely_available')) {
    return { state: 'available', spots, headline: `${spots} possible ${spots === 1 ? 'spot' : 'spots'} nearby` };
  }
  if (candidates.length) {
    return { state: 'possible', spots, headline: `Maybe ${spots} ${spots === 1 ? 'spot' : 'spots'} nearby` };
  }
  if (watchedCurrent > 0) return { state: 'none', spots: 0, headline: 'No parking currently detected' };
  return { state: 'unknown', spots: 0, headline: 'No current camera data' };
}

/** Prettify TMC names like "Audobon Ave @ W 181 ST" -> "Audubon Ave near W 181st". */
export function prettyCameraName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\bAudobon\b/gi, 'Audubon')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(W|E)\s+(\d+)\s*(st|ST|St)?\b/g, (_m, dir: string, n: string) => `${dir.toUpperCase()} ${ordinal(Number(n))}`)
    .replace(/@\s*(\d+)\s*(St|ST|st)\b/g, (_m, n: string) => `@ W ${ordinal(Number(n))}`)
    .replace(/\s*@\s*/, ' near ');
}

function ordinal(n: number): string {
  return `${n}${suffix(n)}`;
}

function suffix(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}
