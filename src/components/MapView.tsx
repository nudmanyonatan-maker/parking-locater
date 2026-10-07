// Leaflet map (no react-leaflet): the map is created once and layers are
// rebuilt imperatively when data changes. Callbacks go through refs so
// markers don't need rebuilding when handlers change identity.
//
// Framing: until the user pans, the map keeps home + parking + watched cameras
// in the part of the screen not covered by the status pill and bottom sheet.

import L from 'leaflet';
import { useEffect, useRef } from 'react';
import type { CameraSummary, ParkingCandidate, ParkingStatus } from '../../shared/types';
import type { LatLon } from '../../shared/geo';
import { cameraLabel } from '../lib/format';
import { cameraIcon, cameraTitle, homeIcon, parkingIcon } from './mapIcons';
import { candidateMarkerPositions, onMarkerActivate, type MarkerPosition } from './mapMarkers';
import 'leaflet/dist/leaflet.css';
import './map.css';

export interface MapInsets {
  top: number;
  bottom: number;
}

interface Props {
  home: LatLon;
  radiusMi: number | null;
  cameras: CameraSummary[];
  watchedIds: ReadonlySet<string>;
  /** Status dot per watched camera, already checked for age/freshness (see cameraMarkerStatus). */
  cameraStatus: ReadonlyMap<string, ParkingStatus | null>;
  candidates: ParkingCandidate[];
  selectedCameraId: string | null;
  selectedCandidate: number | null;
  onCameraTap: (id: string) => void;
  onCandidateTap: (index: number) => void;
  /** Pixels covered by floating UI, so "center" means the visible part of the map. */
  insets: MapInsets;
  /** Increment to re-frame home and the results. */
  recenterToken: number;
}

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

/** Honour "Reduce Motion" for map pans and zooms too. */
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const HOME_ZOOM = 16;
const MAX_FIT_ZOOM = 17;
const MI_TO_M = 1609.344;
/** Room for the right-hand control column when framing. */
const CONTROLS_W = 96;

/** Dashed line from a moved parking marker back to the candidate's own point (camera or lane anchor). */
function syncTether(g: L.LayerGroup, tether: L.Polyline | null, c: ParkingCandidate, pos: MarkerPosition): L.Polyline | null {
  if (!pos.moved) {
    if (tether) g.removeLayer(tether);
    return null;
  }
  const points: L.LatLngExpression[] = [
    [c.lat, c.lon],
    [pos.lat, pos.lon],
  ];
  if (tether) return tether.setLatLngs(points);
  return L.polyline(points, { className: 'mk-tether', interactive: false, weight: 2, dashArray: '3 5' }).addTo(g);
}

/** Center `target` within the part of the map not covered by `insets`. */
function centerIn(map: L.Map, target: L.LatLngExpression, insets: MapInsets, zoom?: number) {
  const z = zoom ?? map.getZoom();
  const shift = (insets.bottom - insets.top) / 2;
  const center = map.unproject(map.project(target, z).add([0, shift]), z);
  map.setView(center, z, { animate: !reducedMotion() });
}

/** Fit points into the uncovered part of the map. Skips when that area is too small to be useful. */
function frame(map: L.Map, points: L.LatLng[], insets: MapInsets, animate: boolean) {
  const size = map.getSize();
  if (size.y - insets.top - insets.bottom < 150 || points.length === 0) return;
  map.fitBounds(L.latLngBounds(points), {
    paddingTopLeft: [36, insets.top + 44],
    paddingBottomRight: [CONTROLS_W, insets.bottom + 40],
    maxZoom: points.length === 1 ? HOME_ZOOM : MAX_FIT_ZOOM,
    animate: animate && !reducedMotion(),
  });
}

export function MapView(props: Props) {
  const { home, radiusMi, cameras, watchedIds, cameraStatus, candidates, selectedCameraId, selectedCandidate, insets, recenterToken } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<{ home: L.LayerGroup; cameras: L.LayerGroup; parking: L.LayerGroup } | null>(null);
  const parkingMarkers = useRef(new Map<string, { marker: L.Marker; tether: L.Polyline | null; sig: string; index: number }>());
  const handlers = useRef({ onCameraTap: props.onCameraTap, onCandidateTap: props.onCandidateTap });
  const insetsRef = useRef(insets);
  const initialHome = useRef(home);
  const camerasRef = useRef(cameras);
  /** Set once the user pans, so we stop re-framing automatically. */
  const userMoved = useRef(false);
  const firstFrame = useRef(true);

  // What "the interesting area" is: home, parking markers, watched cameras.
  const focus: L.LatLng[] = [
    L.latLng(home.lat, home.lon),
    ...candidateMarkerPositions(candidates).map((p) => L.latLng(p.lat, p.lon)),
    ...cameras.filter((c) => watchedIds.has(c.id)).map((c) => L.latLng(c.lat, c.lon)),
  ];
  const focusRef = useRef(focus);
  const focusKey = focus.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');

  useEffect(() => {
    handlers.current = { onCameraTap: props.onCameraTap, onCandidateTap: props.onCandidateTap };
    insetsRef.current = insets;
    camerasRef.current = cameras;
    focusRef.current = focus;
  });

  // Create the map once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = initialHome.current;
    const map = L.map(el, {
      zoomControl: false,
      center: [h.lat, h.lon],
      zoom: HOME_ZOOM,
      maxZoom: 19,
      minZoom: 11,
      zoomSnap: 0.25,
      tapTolerance: 20,
      zoomAnimation: !reducedMotion(),
      markerZoomAnimation: !reducedMotion(),
    });
    map.attributionControl.setPrefix(false);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
    layers.current = {
      home: L.layerGroup().addTo(map),
      cameras: L.layerGroup().addTo(map),
      parking: L.layerGroup().addTo(map),
    };
    map.on('dragstart', () => {
      userMoved.current = true;
    });
    mapRef.current = map;
    const markers = parkingMarkers.current;
    return () => {
      map.remove();
      markers.clear();
      mapRef.current = null;
      layers.current = null;
    };
  }, []);

  // Home marker + search radius.
  useEffect(() => {
    const g = layers.current?.home;
    if (!g) return;
    g.clearLayers();
    if (radiusMi) {
      L.circle([home.lat, home.lon], { radius: radiusMi * MI_TO_M, className: 'mk-radius', interactive: false }).addTo(g);
    }
    L.marker([home.lat, home.lon], { icon: homeIcon(), zIndexOffset: 2000, keyboard: false, interactive: false, title: 'Home' }).addTo(g);
  }, [home.lat, home.lon, radiusMi]);

  // Camera markers.
  useEffect(() => {
    const g = layers.current?.cameras;
    if (!g) return;
    g.clearLayers();
    for (const cam of cameras) {
      const watched = watchedIds.has(cam.id);
      const freshness = cam.frame.freshness;
      const status = cameraStatus.get(cam.id) ?? null;
      const marker = L.marker([cam.lat, cam.lon], {
        icon: cameraIcon({ freshness, watched, selected: cam.id === selectedCameraId, status }),
        title: cameraTitle(cameraLabel(cam), freshness, status),
        zIndexOffset: cam.id === selectedCameraId ? 1500 : watched ? 200 : 0,
        riseOnHover: true,
      });
      onMarkerActivate(marker, () => handlers.current.onCameraTap(cam.id));
      marker.addTo(g);
    }
  }, [cameras, watchedIds, cameraStatus, selectedCameraId]);

  // Parking markers (+ dashed tether when the marker was moved off its own point).
  // Diffed by key so the per-second re-render doesn't recreate (and re-animate) them.
  useEffect(() => {
    const g = layers.current?.parking;
    if (!g) return;
    const existing = parkingMarkers.current;
    const positions = candidateMarkerPositions(candidates);
    const seen = new Set<string>();
    candidates.forEach((c, i) => {
      const key = `${c.cameraId}|${c.regionId ?? ''}|${c.gapStart}|${c.gapEnd}`;
      const pos = positions[i]!;
      const selected = i === selectedCandidate;
      const sig = `${c.status}|${c.spaces}|${selected}|${pos.lat},${pos.lon}`;
      seen.add(key);
      const entry = existing.get(key);
      if (entry) {
        entry.index = i;
        if (entry.sig === sig) return;
        entry.sig = sig;
        entry.marker.setLatLng([pos.lat, pos.lon]);
        entry.marker.setIcon(parkingIcon({ status: c.status, spaces: c.spaces, selected, animate: false }));
        entry.marker.setZIndexOffset(selected ? 1800 : 1000 - i);
        entry.tether = syncTether(g, entry.tether, c, pos);
        return;
      }
      const tether = syncTether(g, null, c, pos);
      const marker = L.marker([pos.lat, pos.lon], {
        icon: parkingIcon({ status: c.status, spaces: c.spaces, selected, animate: true }),
        title: `Parking: ${c.streetLabel}, ${c.spaces} possible ${c.spaces === 1 ? 'space' : 'spaces'}`,
        zIndexOffset: selected ? 1800 : 1000 - i,
        riseOnHover: true,
      }).addTo(g);
      const created = { marker, tether, sig, index: i };
      onMarkerActivate(marker, () => handlers.current.onCandidateTap(created.index));
      existing.set(key, created);
    });
    for (const [key, entry] of existing) {
      if (seen.has(key)) continue;
      g.removeLayer(entry.marker);
      if (entry.tether) g.removeLayer(entry.tether);
      existing.delete(key);
    }
  }, [candidates, selectedCandidate]);

  // Recenter button: frame everything again and resume auto-framing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || recenterToken === 0) return;
    userMoved.current = false;
    frame(map, focusRef.current, insetsRef.current, true);
  }, [recenterToken]);

  // Auto-frame when the results change, or when the sheet grows over them,
  // until the user takes over. (Shrinking the sheet leaves the map alone.)
  const lastFramed = useRef({ key: '', bottom: 0 });
  useEffect(() => {
    const map = mapRef.current;
    if (!map || userMoved.current || selectedCameraId) return;
    const last = lastFramed.current;
    if (focusKey === last.key && insets.bottom <= last.bottom + 8) return;
    lastFramed.current = { key: focusKey, bottom: insets.bottom };
    frame(map, focusRef.current, { top: insets.top, bottom: insets.bottom }, !firstFrame.current);
    firstFrame.current = false;
  }, [insets.top, insets.bottom, focusKey, selectedCameraId]);

  // Bring the selected camera into view above the (half-height) sheet.
  const camerasReady = cameras.length > 0;
  useEffect(() => {
    const map = mapRef.current;
    const cam = camerasRef.current.find((c) => c.id === selectedCameraId);
    if (!map || !cam) return;
    userMoved.current = true;
    const bottom = Math.min(insetsRef.current.bottom, window.innerHeight * 0.55);
    centerIn(map, [cam.lat, cam.lon], { top: insetsRef.current.top, bottom }, Math.max(map.getZoom(), HOME_ZOOM));
  }, [selectedCameraId, camerasReady]);

  return <div ref={containerRef} className="map" role="application" aria-label="Map of parking and cameras near home" />;
}
