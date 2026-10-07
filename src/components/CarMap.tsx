// MapLibre map for "My car": home 🏠, the car 🚗 (draggable), a dashed line
// between them, your live location, and emoji place labels for orientation.
// Loaded lazily (MapLibre is big); imperative bits are exposed via a ref.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { LatLng } from '../lib/car';
import './car-map.css';

export interface CarMapHandle {
  center(): LatLng | null;
  /** Fit home, car and you (or just home). */
  frame(): void;
  flyTo(p: LatLng, zoom?: number): void;
  locate(): void;
}

interface Props {
  home: LatLng;
  car: LatLng | null;
  /** Hide the car pin while placing it with the crosshair. */
  placing: boolean;
  onCarMoved(p: LatLng): void;
  onMe(p: LatLng): void;
}

const ll = (p: LatLng): [number, number] => [p.lng, p.lat];
const dark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
const styleUrl = () => `https://tiles.openfreemap.org/styles/${dark() ? 'dark' : 'liberty'}`;

function pin(className: string, text: string) {
  const el = document.createElement('div');
  el.className = `map-pin ${className}`;
  el.textContent = text;
  return el;
}

// Emoji for OpenMapTiles POI classes (bodegas, Dunkin', YU, garages…).
const POI_EMOJI: Record<string, string> = {
  cafe: '☕', fast_food: '🍔', restaurant: '🍴', bar: '🍺', pub: '🍺',
  convenience: '🏪', grocery: '🛒', supermarket: '🛒', greengrocer: '🥬', bakery: '🥐',
  shop: '🛍️', clothing_store: '👕', department_store: '🏬', marketplace: '🛒',
  parking: '🅿️', fuel: '⛽', bank: '🏦', atm: '🏧', pharmacy: '💊', hospital: '🏥',
  college: '🎓', university: '🎓', school: '🏫', library: '📚',
  place_of_worship: '🕍', post: '📮', police: '🚓', fire_station: '🚒', laundry: '🧺',
  hairdresser: '💈', car: '🚙', car_repair: '🔧', hardware: '🛠️', books: '📚',
};

function emojiImage(emoji: string): ImageData {
  const size = 44;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.font = '34px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2);
  return ctx.getImageData(0, 0, size, size);
}

function addPoiLayer(map: maplibregl.Map) {
  for (const id of ['poi_r1', 'poi_r7', 'poi_r20']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }
  if (!map.getSource('openmaptiles')) return;
  for (const [cls, emoji] of Object.entries(POI_EMOJI)) if (!map.hasImage(`poi-${cls}`)) map.addImage(`poi-${cls}`, emojiImage(emoji), { pixelRatio: 2 });
  if (!map.hasImage('poi-generic')) map.addImage('poi-generic', emojiImage('📍'), { pixelRatio: 2 });
  map.addLayer({
    id: 'poi-emoji',
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'poi',
    minzoom: 14,
    filter: [
      'all',
      ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
      ['!', ['match', ['get', 'class'], ['bus', 'rail', 'airport', 'ferry_terminal', 'bicycle_rental', 'entrance', 'pitch'], true, false]],
      ['has', 'name'],
    ],
    layout: {
      'icon-image': ['coalesce', ['image', ['concat', 'poi-', ['get', 'class']]], ['image', 'poi-generic']],
      'icon-size': 0.9,
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11,
      'text-anchor': 'top',
      'text-offset': [0, 0.7],
      'text-optional': true,
      'text-max-width': 9,
      'symbol-sort-key': ['to-number', ['coalesce', ['get', 'rank'], 100]],
    },
    paint: {
      'text-color': dark() ? '#e5e7eb' : '#111827',
      'text-halo-color': dark() ? '#000000' : '#ffffff',
      'text-halo-width': 1.4,
    },
  });
}

const CarMap = forwardRef<CarMapHandle, Props>(function CarMap({ home, car, placing, onCarMoved, onMe }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const geolocate = useRef<maplibregl.GeolocateControl | null>(null);
  const homeMarker = useRef<maplibregl.Marker | null>(null);
  const carMarker = useRef<maplibregl.Marker | null>(null);
  const me = useRef<LatLng | null>(null);
  const latest = useRef({ home, car, onCarMoved, onMe });
  useEffect(() => {
    latest.current = { home, car, onCarMoved, onMe };
  });

  const lineData = (): GeoJSON.Feature | GeoJSON.FeatureCollection => {
    const { home: h, car: c } = latest.current;
    return c ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [ll(h), ll(c)] } } : { type: 'FeatureCollection', features: [] };
  };

  const frame = () => {
    const map = mapRef.current;
    if (!map) return;
    const pts = [latest.current.home, latest.current.car, me.current].filter((p): p is LatLng => !!p);
    if (pts.length === 1) return void map.easeTo({ center: ll(pts[0]!), zoom: 16 });
    const b = new maplibregl.LngLatBounds();
    for (const p of pts) b.extend(ll(p));
    map.fitBounds(b, { padding: 60, maxZoom: 17, duration: 600 });
  };

  useImperativeHandle(ref, () => ({
    center: () => {
      const c = mapRef.current?.getCenter();
      return c ? { lat: c.lat, lng: c.lng } : null;
    },
    frame,
    flyTo: (p, zoom = 18) => mapRef.current?.easeTo({ center: ll(p), zoom: Math.max(zoom, mapRef.current.getZoom()) }),
    locate: () => {
      try {
        geolocate.current?.trigger();
      } catch {
        // The user can tap the locate button.
      }
    },
  }));

  // Create the map once.
  useEffect(() => {
    if (!container.current) return;
    const start = latest.current.car ?? latest.current.home;
    const map = new maplibregl.Map({ container: container.current, style: styleUrl(), center: ll(start), zoom: 16, attributionControl: { compact: true } });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }), 'top-right');
    const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserLocation: true });
    geolocate.current = geo;
    map.addControl(geo, 'top-right');
    geo.on('geolocate', (e: GeolocationPosition) => {
      me.current = { lat: e.coords.latitude, lng: e.coords.longitude };
      latest.current.onMe(me.current);
    });
    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: lineData() });
      map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#16a34a', 'line-width': 5, 'line-opacity': 0.9, 'line-dasharray': [0.4, 2] },
      });
      try {
        addPoiLayer(map);
      } catch (e) {
        console.warn('POI layer failed', e);
      }
      if (latest.current.car) frame();
      try {
        geo.trigger();
      } catch {
        // Fine: the locate button is there.
      }
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Created once; props flow in through `latest` and the effects below.
  }, []);

  // Home pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    homeMarker.current?.remove();
    homeMarker.current = new maplibregl.Marker({ element: pin('map-pin-home', '🏠') }).setLngLat(ll(home)).addTo(map);
    (map.getSource('route') as maplibregl.GeoJSONSource | undefined)?.setData(lineData());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lineData reads `latest`.
  }, [home.lat, home.lng]);

  // Car pin (draggable) and the line.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    carMarker.current?.remove();
    carMarker.current = null;
    if (car && !placing) {
      const marker = new maplibregl.Marker({ element: pin('map-pin-car', '🚗'), draggable: true }).setLngLat(ll(car)).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLngLat();
        latest.current.onCarMoved({ lat: p.lat, lng: p.lng });
      });
      carMarker.current = marker;
    }
    (map.getSource('route') as maplibregl.GeoJSONSource | undefined)?.setData(lineData());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lineData reads `latest`.
  }, [car?.lat, car?.lng, placing]);

  return <div ref={container} className="car-map" />;
});

export default CarMap;
