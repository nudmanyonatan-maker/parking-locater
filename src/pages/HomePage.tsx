// The whole app: is there a spot, does my car fit, and the live camera to check.

import { Check, CircleCheck, CircleHelp, CircleX, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CAR } from '../../shared/car';
import { hydrantMarks } from '../../shared/curb-gaps';
import { formatAge } from '../../shared/freshness';
import type { Region } from '../../shared/types';
import { FrameView } from '../components/FrameView';
import { StreetCleaningCard } from '../components/StreetCleaningCard';
import { useFrame } from '../hooks/useFrame';
import { useParking } from '../hooks/useParking';
import { usePageVisible } from '../hooks/usePageVisible';
import { useResource } from '../hooks/useResource';
import { answerFor, lookCameras, shortCameraLabel, type AnswerTone } from '../lib/answer';
import { getCalibration } from '../lib/api';
import { ageSeconds } from '../lib/format';
import './home.css';

const ICON: Record<AnswerTone | 'checking', typeof CircleCheck> = {
  yes: CircleCheck,
  maybe: CircleHelp,
  no: CircleX,
  unknown: CircleHelp,
  checking: LoaderCircle,
};

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export function HomePage() {
  const parking = useParking(60);
  const now = useNow(10_000);
  const visible = usePageVisible();

  // Parking lanes (with hydrants) of the watched cameras.
  const ids = parking.data?.watched.map((c) => c.id) ?? [];
  const lanes = useResource<Record<string, Region[]>>(ids.length ? ids.join(',') : null, async (signal) => {
    const all = await Promise.all(ids.map((id) => getCalibration(id, signal)));
    return Object.fromEntries(ids.map((id, i) => [id, (all[i]?.regions ?? []).filter((r) => r.kind === 'parking')]));
  });

  const answer = parking.data ? answerFor(parking.data, lanes.data ?? {}, now) : null;
  // Which camera to look at: the one the answer is about, unless you tap another.
  const [picked, setPicked] = useState<string | null>(null);
  const cameras = parking.data ? lookCameras(parking.data) : [];
  const camera = cameras.find((c) => c.id === picked) ?? answer?.camera ?? null;
  const checked = !!camera && parking.data?.watched.some((c) => c.id === camera.id);
  const frame = useFrame(camera?.id ?? null, { intervalMs: 10_000, active: visible });

  const tone: AnswerTone | 'checking' = answer ? answer.tone : 'checking';
  const Icon = ICON[tone];
  const title = answer?.title ?? (parking.error ? "Can't reach the server" : 'Checking the street…');
  const detail = answer?.detail ?? (parking.error ? parking.error.message : '');

  const spotsHere = answer?.spots.filter((s) => s.candidate.cameraId === camera?.id).map((s) => s.candidate) ?? [];
  const hydrants = camera ? (lanes.data?.[camera.id] ?? []).flatMap((r) => hydrantMarks(r)) : [];
  const facts = answer?.spot?.facts ?? null;
  const frameAge = frame.fetchedAt ? formatAge(Math.max(0, Math.round((now - frame.fetchedAt) / 1000))) : null;

  const checkAgain = () => {
    parking.refresh();
    frame.reload();
  };

  return (
    <main className="home">
      <section className={`answer answer-${tone}`} aria-live="polite">
        <Icon className={tone === 'checking' ? 'spin' : undefined} size={44} strokeWidth={2.2} aria-hidden="true" />
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
      </section>

      {facts && (
        <ul className="facts">
          <li className={facts.fits ? 'ok' : 'warn'}>
            {facts.fits ? <Check size={20} aria-hidden="true" /> : <TriangleAlert size={20} aria-hidden="true" />}
            <div>
              <strong>{facts.fits ? `Your ${CAR.short} fits` : 'Probably too tight'}</strong>
              <span>
                About {facts.openFt} ft open, it needs {facts.needFt} ft
              </span>
            </div>
          </li>
          {facts.hydrantFt !== null && (
            <li className="ok">
              <Check size={20} aria-hidden="true" />
              <div>
                <strong>{facts.hydrantFt} ft from the hydrant</strong>
                <span>OK by your 5 ft rule</span>
              </div>
            </li>
          )}
        </ul>
      )}

      <figure className="cam">
        {cameras.length > 1 && (
          <div className="cam-tabs" role="group" aria-label="Camera">
            {cameras.map((c) => (
              <button key={c.id} type="button" aria-pressed={c.id === camera?.id} onClick={() => setPicked(c.id)}>
                {shortCameraLabel(c)}
              </button>
            ))}
          </div>
        )}
        <FrameView
          src={frame.src}
          alt={camera ? `Live camera: ${camera.preference.streetLabel ?? camera.name}` : 'Live camera'}
          overlay={{ candidates: spotsHere, hydrants }}
          aspect={frame.width && frame.height ? frame.width / frame.height : 352 / 240}
          loading={!frame.error}
          errorText={frame.error ? 'Camera image unavailable' : null}
        />
        <figcaption>
          {checked ? (
            <>
              <span>
                <i className="key key-open" /> open curb
              </span>
              <span>
                <i className="key key-hydrant" /> hydrant
              </span>
            </>
          ) : (
            <span>Just a look, no parking check here</span>
          )}
          {frameAge && <span className="cam-age">Camera {frameAge}</span>}
        </figcaption>
      </figure>

      <button type="button" className="check" onClick={checkAgain} disabled={parking.working}>
        <RefreshCw size={20} className={parking.working ? 'spin' : undefined} aria-hidden="true" />
        {parking.working ? 'Checking…' : 'Check again'}
      </button>
      {parking.data?.summary.updatedAt && !parking.working && (
        <p className="checked">Checked {formatAge(ageSeconds(parking.data.summary.updatedAt, now))}</p>
      )}

      <StreetCleaningCard now={now} />
    </main>
  );
}
