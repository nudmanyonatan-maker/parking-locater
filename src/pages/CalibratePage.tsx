// /calibrate/:cameraId — draw the parking lane (and restricted / ignore /
// context regions) on a frozen frame, preview car slots, save, and test.
// Desktop-first; works with touch too.

import { Lock, RefreshCw, ScanSearch, Trash } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import type { AppSettings, Calibration, CameraDetail, Detection } from '../../shared/types';
import { formatMiles, type LatLon } from '../../shared/geo';
import { FALLBACK_HOME } from '../../shared/settings';
import { STATUS_LABEL } from '../../shared/status';
import { ErrorBanner } from '../components/ErrorBanner';
import { NavBar } from '../components/NavBar';
import { OverlayLegend } from '../components/FrameView';
import { Toggle } from '../components/Toggle';
import { useAdmin } from '../hooks/useAdmin';
import { useFrame } from '../hooks/useFrame';
import { usePageVisible } from '../hooks/usePageVisible';
import { useResource } from '../hooks/useResource';
import { analyzeCamera, deleteCalibration, getCalibration, getCamera, getSettings, saveCalibration, toApiError } from '../lib/api';
import { cameraLabel, formatClock, formatClockSeconds, formatPercent, reasonText, STATUS_TONE } from '../lib/format';
import { toast } from '../lib/toast';
import { CalibrationCanvas } from './calibrate/CalibrationCanvas';
import { editorReducer, initialEditor, MAX_REGIONS, newRegionId, regionProblem, regionsForSave } from './calibrate/editor';
import { RegionFields, RegionList, ToolPicker } from './calibrate/RegionPanel';
import './calibrate/calibrate.css';

export default function CalibratePage({ cameraId }: { cameraId: string }) {
  const { isAdmin, unlock } = useAdmin();
  const camera = useResource<CameraDetail>(isAdmin ? cameraId : null, (signal) => getCamera(cameraId, signal));
  const calibration = useResource<Calibration | null>(isAdmin ? cameraId : null, (signal) => getCalibration(cameraId, signal));
  // Home is only needed for the anchor map; the fallback is fine until it loads.
  const settings = useResource<AppSettings>(isAdmin ? 'settings' : null, (signal) => getSettings(signal));

  if (!isAdmin) {
    return (
      <div className="page cal-page">
        <NavBar title="Calibrate" backLabel="Back" backTo="/" />
        <div className="cal-locked card">
          <div className="empty">
            <div className="empty-icon">
              <Lock size={24} aria-hidden="true" />
            </div>
            <h2>Admin token</h2>
            <p>Changing the curb outline needs the admin token (the PARKNEARME_ADMIN_TOKEN GitHub secret).</p>
            <UnlockForm onUnlock={unlock} />
          </div>
        </div>
      </div>
    );
  }

  const error = camera.error ?? calibration.error;
  if (error && (!camera.data || calibration.data === undefined)) {
    return (
      <div className="page cal-page">
        <NavBar title="Calibrate" backLabel="Back" backTo="/" />
        <div className="cal-pad">
          <ErrorBanner
            title="Couldn't load this camera"
            message={error.status === 404 ? 'This camera is not in the catalog.' : error.message}
            onRetry={() => {
              camera.reload();
              calibration.reload();
            }}
          />
        </div>
      </div>
    );
  }

  if (!camera.data || calibration.data === undefined) {
    return (
      <div className="page cal-page" aria-busy="true">
        <NavBar title="Calibrate" backLabel="Back" backTo="/" />
        <div className="cal-pad">
          <div className="skeleton" style={{ width: 220, height: 34 }} />
          <div className="skeleton" style={{ maxWidth: 880, aspectRatio: '352 / 240', marginTop: 20, borderRadius: 16 }} />
        </div>
      </div>
    );
  }

  return <CalibrationEditor key={cameraId} camera={camera.data} initial={calibration.data} home={settings.data?.home ?? FALLBACK_HOME} />;
}

function UnlockForm({ onUnlock }: { onUnlock: (token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="unlock-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        onUnlock(token)
          .catch((err: unknown) => setError(toApiError(err).message))
          .finally(() => setBusy(false));
      }}
    >
      <input
        className="field"
        type="password"
        autoComplete="current-password"
        aria-label="Admin token"
        placeholder="Admin token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <button className="btn btn-primary" type="submit" disabled={busy || !token.trim()}>
        {busy ? 'Checking…' : 'Unlock'}
      </button>
      {error && (
        <p className="unlock-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function detailLines(details: unknown): string[] {
  if (!details) return [];
  if (Array.isArray(details)) {
    return details.map((d) => {
      if (typeof d === 'string') return d;
      if (d && typeof d === 'object') {
        const o = d as { path?: unknown; message?: unknown };
        const path = Array.isArray(o.path) ? o.path.join('.') : typeof o.path === 'string' ? o.path : '';
        return `${path ? `${path}: ` : ''}${typeof o.message === 'string' ? o.message : JSON.stringify(d)}`;
      }
      return String(d);
    });
  }
  if (typeof details === 'object')
    return Object.entries(details as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return [String(details)];
}

function CalibrationEditor({ camera, initial, home }: { camera: CameraDetail; initial: Calibration | null; home: LatLon }) {
  const [state, dispatch] = useReducer(editorReducer, initial?.regions ?? [], initialEditor);
  const visible = usePageVisible();
  const [freeze, setFreeze] = useState(true);
  // Frozen by default so the image doesn't change while drawing.
  const frame = useFrame(camera.id, { intervalMs: freeze ? 0 : 5000, active: visible });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; details: string[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<Detection | null>(null);
  const [showTest, setShowTest] = useState(true);
  const [savedAt, setSavedAt] = useState<string | null>(initial?.updatedAt ?? null);
  const [onServer, setOnServer] = useState(initial !== null);

  const selected = state.regions.find((r) => r.id === state.selectedId) ?? null;
  const problems = state.regions.filter((r) => regionProblem(r) !== null);
  const hasLane = state.regions.some((r) => r.kind === 'parking');
  const canSave = state.dirty && problems.length === 0 && !saving;
  const aspect =
    frame.width && frame.height ? frame.width / frame.height : initial ? initial.referenceWidth / initial.referenceHeight : 352 / 240;

  // Keyboard: Esc cancels, Enter finishes a polygon, Backspace/Delete undo a point or delete the region.
  const { tool, draft, selectedId } = state;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'cancel' });
        return;
      }
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, button, a')) return;
      if (e.key === 'Enter' && draft.length >= 3 && tool !== 'select' && tool !== 'parking') {
        e.preventDefault();
        dispatch({ type: 'finish', newId: newRegionId(tool) });
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (draft.length) {
          e.preventDefault();
          dispatch({ type: 'undoPoint' });
        } else if (selectedId) {
          e.preventDefault();
          if (window.confirm('Delete this region?')) dispatch({ type: 'delete', id: selectedId });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, draft.length, selectedId]);

  // Warn before closing the tab with unsaved work.
  useEffect(() => {
    if (!state.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [state.dirty]);

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    try {
      const cal = await saveCalibration(camera.id, {
        regions: regionsForSave(state.regions),
        referenceWidth: frame.width ?? initial?.referenceWidth ?? 352,
        referenceHeight: frame.height ?? initial?.referenceHeight ?? 240,
      });
      dispatch({ type: 'saved', regions: state.regions });
      setSavedAt(cal.updatedAt);
      setOnServer(true);
      toast('Calibration saved');
      return true;
    } catch (err) {
      const e = toApiError(err);
      setSaveError({ message: e.message, details: detailLines(e.details) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (state.dirty && !(await save())) return;
    setTesting(true);
    try {
      const det = await analyzeCamera(camera.id, { force: true });
      setTest(det);
      setShowTest(true);
      // The server caches frames for a few seconds, so this is (nearly) the analyzed frame.
      frame.reload();
    } catch (err) {
      toast(toApiError(err).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Delete this camera's calibration? Parking can't be detected here until it's calibrated again.")) return;
    try {
      await deleteCalibration(camera.id);
      dispatch({ type: 'reset', regions: [] });
      setOnServer(false);
      setSavedAt(null);
      setTest(null);
      toast('Calibration deleted', 'info');
    } catch (err) {
      toast(toApiError(err).message, 'error');
    }
  };

  const saveLabel = saving ? 'Saving…' : 'Save';
  const disabledReason = problems.length ? 'Fix the highlighted regions first' : !state.dirty ? 'No changes to save' : undefined;

  return (
    <div className="page cal-page">
      <NavBar
        title="Calibrate"
        backLabel="Cameras"
        backTo="/cameras"
        confirmLeave={state.dirty ? 'Discard unsaved calibration changes?' : undefined}
      >
        {state.dirty && (
          <span className="cal-unsaved" role="status">
            <span className="dot tone-orange" aria-hidden="true" /> Unsaved
          </span>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm cal-save-top"
          onClick={() => void save()}
          disabled={!canSave}
          title={disabledReason}
        >
          {saveLabel}
        </button>
      </NavBar>

      <header className="cal-header">
        <h1 className="large-title">Calibrate</h1>
        <p className="large-subtitle tabular">
          {cameraLabel(camera)} · {formatMiles(camera.distanceMi)} from home ·{' '}
          {savedAt ? `saved ${formatClock(savedAt)}` : 'not calibrated yet'}
        </p>
      </header>

      <div className="cal-layout">
        <div className="cal-main">
          <div className="cal-frame-bar">
            <label className="cal-freeze">
              <Toggle checked={freeze} onChange={setFreeze} label="Freeze frame" />
              <span>Freeze frame</span>
            </label>
            <button type="button" className="btn btn-plain btn-sm" onClick={frame.reload}>
              <RefreshCw size={15} aria-hidden="true" />
              New frame
            </button>
            <span className="cal-frame-time tabular">
              {frame.fetchedAt ? `Frame ${formatClockSeconds(new Date(frame.fetchedAt).toISOString())}` : ''}
              {frame.width ? ` · ${frame.width}×${frame.height}` : ''}
            </span>
          </div>

          <CalibrationCanvas
            state={state}
            dispatch={dispatch}
            src={frame.src}
            aspect={aspect}
            loadingText={frame.error ? frame.error.message : 'Loading frame…'}
            test={test && showTest ? test : null}
          />

          {saveError && (
            <div className="banner tone-red cal-save-error" role="alert">
              <div className="banner-body">
                <strong>Couldn't save: {saveError.message}</strong>
                {saveError.details.length > 0 && (
                  <ul>
                    {saveError.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {test && <TestResult test={test} show={showTest} onShow={setShowTest} />}
        </div>

        <aside className="cal-side">
          <section className="cal-card card">
            <h2>Draw</h2>
            <ToolPicker tool={state.tool} onTool={(t) => dispatch({ type: 'tool', tool: t })} />
            {state.tool !== 'select' && state.tool !== 'parking' && (
              <div className="cal-draw-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={state.draft.length < 3}
                  onClick={() => dispatch({ type: 'finish', newId: newRegionId(state.tool === 'select' ? 'ignore' : state.tool) })}
                >
                  Finish shape
                </button>
                <button type="button" className="btn btn-plain btn-sm" onClick={() => dispatch({ type: 'cancel' })}>
                  Cancel
                </button>
              </div>
            )}
          </section>

          <section className="cal-card card">
            <h2>
              Regions <span className="cal-count">{state.regions.length}</span>
            </h2>
            <RegionList state={state} dispatch={dispatch} />
            {!hasLane && state.regions.length > 0 && <p className="cal-warn">Add a parking lane — without one, nothing can be detected.</p>}
            {state.regions.length >= MAX_REGIONS && <p className="cal-warn">That's the maximum of {MAX_REGIONS} regions.</p>}
          </section>

          {selected && (
            <section className="cal-card card">
              <h2>Selected region</h2>
              <RegionFields region={selected} dispatch={dispatch} camera={camera} home={home} />
            </section>
          )}

          <section className="cal-card card cal-actions">
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!canSave} title={disabledReason}>
              {saveLabel}
            </button>
            {disabledReason && state.dirty && <p className="cal-warn">{disabledReason}.</p>}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void runTest()}
              disabled={testing || saving || problems.length > 0 || (!onServer && !state.dirty)}
            >
              <ScanSearch size={18} aria-hidden="true" className={testing ? 'pulse' : undefined} />
              {testing ? 'Analyzing…' : state.dirty ? 'Save & test analysis' : 'Test analysis'}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={!onServer}>
              <Trash size={16} aria-hidden="true" />
              Delete calibration
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TestResult({ test, show, onShow }: { test: Detection; show: boolean; onShow: (v: boolean) => void }) {
  const tone = STATUS_TONE[test.status];
  const reason = test.status === 'unknown' ? reasonText(test.reason) : null;
  return (
    <section className={`cal-test card tone-${tone}`} aria-label="Test analysis result">
      <div className="cal-test-head">
        <span className="dot" aria-hidden="true" />
        <div>
          <h3>{STATUS_LABEL[test.status]}</h3>
          <p className="tabular">
            {test.vehiclesDetected} vehicles ({test.parkedVehicles} parked) · {test.candidateSpaces} possible{' '}
            {test.candidateSpaces === 1 ? 'space' : 'spaces'}
            {test.status !== 'unknown' ? ` · ${formatPercent(test.confidence)}` : ''} · {formatClockSeconds(test.timestamp)} ·{' '}
            {test.detector}
          </p>
          {reason && <p className="cal-test-reason">{reason}</p>}
        </div>
        <label className="cal-test-toggle">
          <span>Overlay</span>
          <Toggle checked={show} onChange={onShow} label="Show test overlay" />
        </label>
      </div>
      {show && <OverlayLegend showRegions={false} />}
      {(test.notes.length > 0 || test.candidates.length > 0) && (
        <details className="cal-test-notes">
          <summary>Analyzer notes</summary>
          <ul>
            {test.candidates.map((c, i) => (
              <li key={`c${i}`}>
                {c.streetLabel}: {c.spaces} {c.spaces === 1 ? 'space' : 'spaces'}, {formatPercent(c.confidence)} — {c.reasons.join('; ')}
              </li>
            ))}
            {test.notes.map((n, i) => (
              <li key={`n${i}`}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
