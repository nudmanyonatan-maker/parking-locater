// Marker placement and activation for MapView. No Leaflet runtime import, so
// this stays testable outside a browser.

import type { LeafletKeyboardEvent, Marker } from 'leaflet';
import type { LatLon } from '../../shared/geo';
import type { ParkingCandidate } from '../../shared/types';

/** How far a parking marker is pushed away from a point it shares with others (or with its camera). */
export const FAN_OUT_M = 25;

/** Move `p` by `meters` toward `bearingDeg` (small-distance approximation). */
export function offsetLatLon(p: LatLon, meters: number, bearingDeg: number): LatLon {
  const b = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(b)) / 111_320;
  const dLon = (meters * Math.sin(b)) / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

export interface MarkerPosition extends LatLon {
  /** Drawn away from the candidate's own lat/lon (MapView adds a tether back to it). */
  moved: boolean;
}

/**
 * Where each candidate's marker goes. Approximate candidates (camera position)
 * are fanned out around it. Several gaps on one anchored lane share the
 * anchor: the first keeps it and the rest fan out, so no marker hides another.
 */
export function candidateMarkerPositions(candidates: Pick<ParkingCandidate, 'lat' | 'lon' | 'approximateLocation'>[]): MarkerPosition[] {
  const claimed = new Set<string>();
  const fanned = new Map<string, number>();
  return candidates.map((c) => {
    const key = `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
    if (!c.approximateLocation && !claimed.has(key)) {
      claimed.add(key);
      return { lat: c.lat, lon: c.lon, moved: false };
    }
    const k = fanned.get(key) ?? 0;
    fanned.set(key, k + 1);
    return { ...offsetLatLon(c, FAN_OUT_M, 40 + k * 55), moved: true };
  });
}

/**
 * Leaflet makes markers focusable role=button elements, but Enter/Space on
 * them does nothing by default. Run `activate` for a tap and for those keys.
 */
export function onMarkerActivate(marker: Pick<Marker, 'on'>, activate: () => void): void {
  marker.on('click', () => activate());
  marker.on('keydown', (e: LeafletKeyboardEvent) => {
    const ev = e.originalEvent;
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    activate();
  });
}
