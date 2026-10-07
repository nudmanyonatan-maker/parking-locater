// "My car": save where you parked (GPS or on the map), find it again, and get
// a Discord ping before street cleaning. The move-by time is set from the
// block's cleaning signs automatically; you can switch sides or set it by hand.

import { Brush, Clock, Crosshair, Footprints, MapPin, Maximize2, Pencil, Check, House } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { sideWord } from '../../shared/cleaning';
import type { CarMapHandle } from '../components/CarMap';
import type { SpotState } from '../hooks/useSpot';
import { toApiError } from '../lib/api';
import { cleaningAt, formatDistance, getHome, haversineMeters, moveByFor, moveByStatus, setHome, walkUrl, whenText, type LatLng } from '../lib/car';
import './car.css';

const CarMap = lazy(() => import('../components/CarMap'));

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** epoch ms <-> the phone's local "YYYY-MM-DDTHH:MM" for <input type="datetime-local">. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

export function CarPage({ spotState }: { spotState: SpotState }) {
  const { spot, save, clear } = spotState;
  const [home, setHomeState] = useState<LatLng>(getHome);
  const [me, setMe] = useState<LatLng | null>(null);
  const [placing, setPlacing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const map = useRef<CarMapHandle>(null);

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
  const park = (p: LatLng) => {
    const auto = moveByFor(p, Date.now());
    return save({ lat: p.lat, lng: p.lng, note: spot?.note ?? '', moveBy: auto.moveBy, faceId: auto.faceId });
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
        await park(p);
        map.current?.frame();
      },
      "Couldn't get GPS.",
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

  const switchSide = (faceId: string) =>
    run('side', async () => {
      if (!spot || !car) return;
      const auto = moveByFor(car, Date.now(), faceId);
      await save({ lat: spot.lat, lng: spot.lng, note: spot.note, moveBy: auto.moveBy, faceId });
    }, "Couldn't switch sides.");

  const setHomeHere = () => {
    if (!window.confirm('Set home to where you are now? (Do this at your building.)')) return;
    void run('home', async () => {
      const p = await currentPosition();
      setHome(p);
      setHomeState(p);
    }, "Couldn't get GPS to set home.");
  };

  return (
    <div className="car-page">
      <div className="car-map-wrap">
        <Suspense fallback={<div className="car-map skeleton" />}>
          <CarMap ref={map} home={home} car={car} placing={placing} onMe={setMe} onCarMoved={(p) => void run('drag', () => park(p), "Couldn't save the new spot.")} />
        </Suspense>
        <div className="map-floats">
          <button type="button" className="map-float" onClick={setHomeHere} aria-label="Set home to my location">
            <House size={20} aria-hidden="true" />
          </button>
          {car && !placing && (
            <button type="button" className="map-float" onClick={() => map.current?.frame()} aria-label="Show home and car">
              <Maximize2 size={20} aria-hidden="true" />
            </button>
          )}
        </div>
        {placing && (
          <div className="crosshair" aria-hidden="true">
            <div className="crosshair-pin">🚗</div>
            <div className="crosshair-dot" />
          </div>
        )}
      </div>

      <section className="car-panel">
        {spot === undefined ? (
          <div className="skeleton" style={{ height: 120, borderRadius: 16 }} />
        ) : placing ? (
          <>
            <p className="car-hint">Drag the map so the 🚗 sits where you parked</p>
            <div className="car-actions two">
              <button type="button" className="btn btn-plain" onClick={() => setPlacing(false)} disabled={!!busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={savePlaced} disabled={!!busy}>
                <Check size={20} aria-hidden="true" /> {busy === 'place' ? 'Saving…' : 'Save here'}
              </button>
            </div>
          </>
        ) : !spot || !car ? (
          <>
            <h1 className="car-title">Where did you park?</h1>
            <button type="button" className="btn btn-primary btn-block btn-big" onClick={parkHere} disabled={!!busy}>
              <MapPin size={22} aria-hidden="true" /> {busy === 'gps' ? 'Getting GPS…' : 'I parked here'}
            </button>
            <button type="button" className="btn btn-secondary btn-block" onClick={() => setPlacing(true)} disabled={!!busy}>
              <Crosshair size={20} aria-hidden="true" /> Set it on the map
            </button>
            <p className="car-hint">At the car? Use GPS. Anywhere else, set it on the map. Street cleaning is checked for you.</p>
          </>
        ) : (
          <>
            <div className="car-head">
              <h1 className="car-title">{me ? `${formatDistance(haversineMeters(me, car))} away` : 'Your car'}</h1>
              <p>🏠 {formatDistance(haversineMeters(home, car))} from home</p>
            </div>

            {moveBy && (
              <div className={`banner tone-${moveBy.tone === 'ok' ? 'blue' : moveBy.tone === 'soon' ? 'orange' : 'red'}`} role="status">
                <Clock size={18} aria-hidden="true" />
                <div className="banner-body">
                  <strong>{moveBy.text}</strong>
                  {moveBy.tone !== 'late' && <span>Discord ping 5 min before</span>}
                </div>
              </div>
            )}

            {cleaning ? (
              <div className="cleaning-here">
                <Brush size={18} aria-hidden="true" />
                <div>
                  <strong>Street cleaning {cleaning.schedule ?? 'here'}</strong>
                  <span>{cleaning.label}</span>
                  {cleaning.next?.active && <span className="warn">Cleaning right now, until {whenText(cleaning.next.end, now).replace(/^Today /, '')}</span>}
                  {cleaning.others.map((f) => (
                    <button key={f.id} type="button" className="btn-link" onClick={() => void switchSide(f.id)} disabled={!!busy}>
                      Parked on the {sideWord(f)} side instead?
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="car-hint">No street-cleaning signs found at this spot.</p>
            )}

            {spot.note && <p className="car-note">📝 {spot.note}</p>}

            <a className="btn btn-primary btn-block btn-big" href={walkUrl(car)}>
              <Footprints size={22} aria-hidden="true" /> Walk to my car
            </a>
            <div className="car-actions">
              <button type="button" className="btn btn-plain" onClick={() => setPlacing(true)} disabled={!!busy}>
                <MapPin size={18} aria-hidden="true" /> Move
              </button>
              <button type="button" className="btn btn-plain" onClick={() => setEditing((v) => !v)} disabled={!!busy} aria-expanded={editing}>
                <Pencil size={18} aria-hidden="true" /> Note
              </button>
              <button type="button" className="btn btn-plain" onClick={() => void run('clear', clear, "Couldn't clear the spot.")} disabled={!!busy}>
                <Check size={18} aria-hidden="true" /> Got it
              </button>
            </div>
            {editing && (
              <EditForm
                note={spot.note}
                moveBy={spot.moveBy}
                busy={!!busy}
                onSave={(note, moveByMs) =>
                  run('edit', async () => {
                    await save({ lat: spot.lat, lng: spot.lng, note, moveBy: moveByMs, faceId: spot.faceId ?? null });
                    setEditing(false);
                  }, "Couldn't save the note or time.")
                }
              />
            )}
          </>
        )}
        {error && (
          <p className="car-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

function EditForm({ note, moveBy, busy, onSave }: { note: string; moveBy: number | null; busy: boolean; onSave: (note: string, moveBy: number | null) => void }) {
  const [text, setText] = useState(note);
  const [when, setWhen] = useState(moveBy ? toLocalInput(moveBy) : '');
  return (
    <form
      className="car-edit"
      onSubmit={(e) => {
        e.preventDefault();
        const ms = when ? new Date(when).getTime() : null;
        onSave(text.trim(), ms !== null && Number.isFinite(ms) ? ms : null);
      }}
    >
      <label className="field-label" htmlFor="car-note">
        Note
      </label>
      <input id="car-note" className="field" maxLength={200} placeholder="e.g. Audubon side, by the hydrant" value={text} onChange={(e) => setText(e.target.value)} />
      <label className="field-label" htmlFor="car-moveby">
        Move by <small>(Discord ping 5 min before; set from street cleaning)</small>
      </label>
      <input id="car-moveby" className="field" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        Save
      </button>
    </form>
  );
}
