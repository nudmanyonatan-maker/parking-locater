// Small Leaflet map to place a parking lane's anchor (where its map pin goes).

import L from 'leaflet';
import { useEffect, useRef } from 'react';
import type { LatLon } from '../../../shared/geo';
import { cameraIcon, homeIcon, parkingIcon } from '../../components/mapIcons';
import { TILE_ATTRIBUTION, TILE_URL } from '../../components/MapView';
import '../../components/map.css';

interface Props {
  camera: LatLon;
  home: LatLon;
  anchor: LatLon | null;
  onPick: (p: LatLon) => void;
}

export function AnchorMap({ camera, home, anchor, onPick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const anchorLayer = useRef<L.LayerGroup | null>(null);
  const pick = useRef(onPick);
  const initial = useRef({ camera, home, anchor });

  useEffect(() => {
    pick.current = onPick;
  });

  useEffect(() => {
    if (!el.current) return;
    const { camera: cam, home: h, anchor: a } = initial.current;
    const m = L.map(el.current, {
      zoomControl: true,
      attributionControl: true,
      center: [a?.lat ?? cam.lat, a?.lon ?? cam.lon],
      zoom: 18,
      maxZoom: 19,
    });
    m.attributionControl.setPrefix(false);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(m);
    L.marker([h.lat, h.lon], { icon: homeIcon(), interactive: false, keyboard: false }).addTo(m);
    L.marker([cam.lat, cam.lon], {
      icon: cameraIcon({ freshness: 'live', watched: false, selected: false, status: null }),
      interactive: false,
      keyboard: false,
    }).addTo(m);
    anchorLayer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => pick.current({ lat: Number(e.latlng.lat.toFixed(6)), lon: Number(e.latlng.lng.toFixed(6)) }));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      anchorLayer.current = null;
    };
  }, []);

  useEffect(() => {
    const g = anchorLayer.current;
    if (!g) return;
    g.clearLayers();
    if (anchor) {
      L.marker([anchor.lat, anchor.lon], {
        icon: parkingIcon({ status: 'likely_available', spaces: 1, selected: false, animate: false }),
        interactive: false,
        keyboard: false,
      }).addTo(g);
      L.polyline(
        [
          [camera.lat, camera.lon],
          [anchor.lat, anchor.lon],
        ],
        { className: 'mk-tether', weight: 2, dashArray: '3 5', interactive: false },
      ).addTo(g);
    }
  }, [anchor, camera.lat, camera.lon]);

  return <div ref={el} className="anchor-map map" aria-label="Click the map to set where this lane's pin goes" />;
}
