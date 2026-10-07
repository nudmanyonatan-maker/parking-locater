// The app: one full-screen map with your car. A frosted card on top says how
// far the car is and when to move it (street cleaning), with a bell for a
// phone alert an hour before; a small card at the bottom has "Walk to car".
// "Find parking" (cameras + street cleaning near home) opens as a sheet from
// the button on top.

import { Bell, BellOff, BellRing, Brush, Check, Crosshair, Footprints, LocateFixed, MapPin, Maximize2, SquareParking, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { sideWord } from '../../shared/cleaning';
import type { CarMapHandle } from '../components/CarMap';
import type { SpotState } from '../hooks/useSpot';
import { toApiError } from '../lib/api';
import { cleaningAt, formatDistance, getHome, haversineMeters, moveByFor, moveByStatus, walkUrl, whenText, type LatLng } from '../lib/car';
import { alertsState, turnOffAlerts, turnOnAlerts, type AlertsState } from '../lib/carAlerts';
import { toast } from '../lib/toast';
import { HomePage } from './HomePage';
import './map-page.css';
import './map-screen.css';

const CarMap = lazy(() => import('../components/CarMap'));

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function currentPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}

const TONE = { ok: 'green', soon: 'orange', late: 'red' } as const;

export function MapScreen({ spotState }: { spotState: SpotState }) {
  const { spot, save, clear } = spotState;
  const [location, navigate] = useLocation();
  const findOpen = location === '/find';
  const [home] = useState<LatLng>(getHome);
  const [me, setMe] = useState<LatLng | null>(null);
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const map = useRef<CarMapHandle>(null);
  const [alerts, setAlerts] = useState<AlertsState | null>(null);

  useEffect(() => {
    alertsState()
      .then(setAlerts)
      .catch(() => setAlerts('off'));
  }, []);

  const car = spot ? { lat: spot.lat, lng: spot.lng } : null;
  const cleaning = car ? cleaningAt(car, now, spot?.faceId) : null;
  const moveBy = spot ? moveByStatus(spot, now) : null;

  const run = async (label: string, action: () => Promise<unknown>, failure: string) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(`${failure} ${toApiError(e).message}`);
    } finally {
      setBusy(null);
    }
  };

  /** Save the car here; the move-by time comes from this block's street cleaning. */
  const park = (p: LatLng, faceId?: string | null, keepNote = true) => {
    const auto = moveByFor(p, Date.now(), faceId);
    // Moving the pin or switching sides keeps the note; a fresh "I parked here" clears it.
    return save({ lat: p.lat, lng: p.lng, note: keepNote ? (spot?.note ?? '') : '', moveBy: auto.moveBy, faceId: auto.faceId });
  };

  const toggleAlerts = () => {
    if (alerts === 'home-screen') return toast('For alerts on iPhone: tap Share, then "Add to Home Screen", and open the app from there.', 'info', 8000);
    if (alerts === 'unsupported') return toast("This browser can't show alerts.", 'error');
    void run(
      'alerts',
      async () => {
        if (alerts === 'on') {
          await turnOffAlerts();
          setAlerts('off');
          toast('Alerts off', 'info');
        } else {
          await turnOnAlerts();
          setAlerts('on');
          toast("Alerts on. You'll get one an hour before Move by.");
        }
      },
      "Couldn't change alerts.",
    );
  };

  const parkHere = () =>
    run(
      'gps',
      async () => {
        let p: LatLng;
        try {
          p = await currentPosition();
        } catch {
          setPlacing(true);
          throw new Error('Drag the map so the 🚗 sits where you parked.');
        }
        await park(p, null, false);
        map.current?.frame();
      },
      "Couldn't get your location.",
    );

  const savePlaced = () =>
    run(
      'place',
      async () => {
        const c = map.current?.center();
        if (!c) throw new Error('The map is still loading.');
        await park(c);
        setPlacing(false);
        map.current?.frame();
      },
      "Couldn't save the spot.",
    );

  // Top card: where the car is and when to move it.
  const headline = !spot ? "Where's your car?" : me && car ? `Car is ${formatDistance(haversineMeters(me, car))} away` : 'Your car';
  const sub = placing
    ? 'Drag the map under the 🚗'
    : !spot
      ? 'Tap below when you park'
      : moveBy
        ? moveBy.text
        : 'No street cleaning here';
  const dot = !spot || !moveBy ? 'gray' : TONE[moveBy.tone];

  return (
    <div className="map-page">
      <Suspense fallback={<div className="car-map skeleton" />}>
        <CarMap ref={map} home={home} car={car} placing={placing} onMe={setMe} onCarMoved={(p) => void run('drag', () => park(p), "Couldn't save the new spot.")} />
      </Suspense>

      <div className="map-top">
        <div className="status-pill glass">
          <button
            type="button"
            className={`bell-btn tone-${dot}${alerts === 'on' ? ' is-on' : ''}`}
            onClick={toggleAlerts}
            disabled={!alerts || busy === 'alerts'}
            aria-pressed={alerts === 'on'}
            aria-label={alerts === 'on' ? 'Alerts on. Tap to turn off.' : 'Alert me an hour before I have to move the car'}
          >
            {alerts === 'on' ? <BellRing size={19} aria-hidden="true" /> : alerts === 'off' || !alerts ? <Bell size={19} aria-hidden="true" /> : <BellOff size={19} aria-hidden="true" />}
          </button>
          <div className="status-text" role="status" aria-live="polite">
            <div className="status-headline">{headline}</div>
            <div className="status-sub">{sub}</div>
          </div>
          <button type="button" className="find-btn" onClick={() => navigate('/find')} aria-label="Find parking">
            <SquareParking size={20} aria-hidden="true" />
            <span>Find parking</span>
          </button>
        </div>
      </div>

      <div className="map-controls">
        <div className="ctl-group glass">
          <button type="button" onClick={() => map.current?.locate()} aria-label="Show where I am">
            <LocateFixed size={21} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => map.current?.frame()} aria-label="Show car and home">
            <Maximize2 size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {placing && (
        <div className="crosshair" aria-hidden="true">
          <div className="crosshair-pin">🚗</div>
          <div className="crosshair-dot" />
        </div>
      )}

      <section className="car-card glass" aria-label="Your car">
        {spot === undefined ? (
          <div className="skeleton" style={{ height: 56, borderRadius: 14 }} />
        ) : placing ? (
          <div className="car-row">
            <button type="button" className="btn btn-plain" onClick={() => setPlacing(false)} disabled={!!busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={savePlaced} disabled={!!busy}>
              <Check size={20} aria-hidden="true" /> {busy === 'place' ? 'Saving…' : 'Car is here'}
            </button>
          </div>
        ) : !spot || !car ? (
          <>
            <button type="button" className="btn btn-primary btn-block btn-big" onClick={parkHere} disabled={!!busy}>
              <MapPin size={22} aria-hidden="true" /> {busy === 'gps' ? 'Getting your location…' : 'I parked here'}
            </button>
            <button type="button" className="btn-link car-link" onClick={() => setPlacing(true)} disabled={!!busy}>
              <Crosshair size={16} aria-hidden="true" /> Set it on the map instead
            </button>
          </>
        ) : (
          <>
            {cleaning && (
              <div className="car-cleaning">
                <Brush size={16} aria-hidden="true" />
                <span>
                  {cleaning.next?.active ? (
                    <strong className="warn">Street cleaning now, until {whenText(cleaning.next.end, now).replace(/^Today /, '')}</strong>
                  ) : (
                    <>Cleaning {cleaning.schedule ?? ''}</>
                  )}{' '}
                  · {cleaning.label.replace(/ \(.*\)$/, '')}
                  {cleaning.others.map((f) => (
                    <button key={f.id} type="button" className="btn-link side-link" onClick={() => void run('side', () => park(car, f.id), "Couldn't switch sides.")} disabled={!!busy}>
                      {sideWord(f)} side instead?
                    </button>
                  ))}
                </span>
              </div>
            )}
            {spot.note && <p className="car-note">📝 {spot.note}</p>}
            <a className="btn btn-primary btn-block btn-big" href={walkUrl(car)}>
              <Footprints size={22} aria-hidden="true" /> Walk to car
            </a>
            <div className="car-row">
              <button type="button" className="btn btn-plain" onClick={() => setPlacing(true)} disabled={!!busy}>
                <MapPin size={18} aria-hidden="true" /> Move pin
              </button>
              <button type="button" className="btn btn-plain" onClick={() => void run('clear', clear, "Couldn't clear the spot.")} disabled={!!busy}>
                <Check size={18} aria-hidden="true" /> Got my car
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="car-error" role="alert">
            {error}
          </p>
        )}
      </section>

      {findOpen && (
        <div className="find-sheet" role="dialog" aria-label="Find parking">
          <button type="button" className="find-close glass" onClick={() => navigate('/')} aria-label="Close">
            <X size={20} aria-hidden="true" />
          </button>
          <div className="find-scroll">
            <HomePage />
          </div>
        </div>
      )}
    </div>
  );
}
