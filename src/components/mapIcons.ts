// HTML for Leaflet divIcon markers (CSS-styled; no default PNG marker images).
// Glyph paths: lucide "camera" (ISC) and a filled house.

import L from 'leaflet';
import type { Freshness, ParkingStatus } from '../../shared/types';
import { STATUS_LABEL } from '../../shared/status';
import { FRESHNESS_LABEL, STATUS_TONE } from '../lib/format';

const CAMERA_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/>' +
  '<circle cx="12" cy="13" r="3"/></svg>';

const HOUSE_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
  '<path fill="currentColor" d="M12.9 2.9a1.4 1.4 0 0 0-1.8 0L3.5 9.3a1.4 1.4 0 0 0-.5 1.1V19.6c0 .8.6 1.4 1.4 1.4H9v-5.6c0-.6.4-1 1-1h4c.6 0 1 .4 1 1V21h4.6c.8 0 1.4-.6 1.4-1.4v-9.2c0-.4-.2-.8-.5-1.1z"/></svg>';

export function homeIcon(): L.DivIcon {
  return L.divIcon({
    className: 'mk',
    html: `<div class="mk-home">${HOUSE_SVG}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

export function cameraIcon(opts: { freshness: Freshness; watched: boolean; selected: boolean; status: ParkingStatus | null }): L.DivIcon {
  const size = opts.watched ? 34 : 28;
  const cls = [
    'mk-cam',
    opts.freshness === 'live' ? 'is-live' : 'is-dim',
    opts.watched ? 'is-watched' : '',
    opts.selected ? 'is-selected' : '',
  ].join(' ');
  // Watched cameras carry a tiny status dot so "checked, nothing open" is visible at a glance.
  const dot = opts.watched && opts.status ? `<span class="mk-cam-dot tone-${STATUS_TONE[opts.status]}"></span>` : '';
  return L.divIcon({
    className: 'mk',
    html: `<div class="${cls}" style="width:${size}px;height:${size}px">${CAMERA_SVG}${dot}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function parkingIcon(opts: { status: ParkingStatus; spaces: number; selected: boolean; animate: boolean }): L.DivIcon {
  const tone = STATUS_TONE[opts.status];
  return L.divIcon({
    className: 'mk',
    html:
      `<div class="mk-park tone-${tone}${opts.selected ? ' is-selected' : ''}${opts.animate ? ' is-new' : ''}">` +
      `<span class="mk-park-pill"><b>P</b><span class="mk-park-n">${opts.spaces}</span></span>` +
      `<span class="mk-park-tail"></span></div>`,
    iconSize: [64, 44],
    iconAnchor: [32, 44],
  });
}

export function cameraTitle(name: string, freshness: Freshness, status: ParkingStatus | null): string {
  return `Camera ${name} · ${FRESHNESS_LABEL[freshness]}${status ? ` · ${STATUS_LABEL[status]}` : ''}`;
}
