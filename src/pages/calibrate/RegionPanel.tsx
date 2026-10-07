// Sidebar: drawing tools, region list and the selected region's fields.

import { Minus, MousePointer2, Plus, Trash } from 'lucide-react';
import { useState, type Dispatch } from 'react';
import { DEFAULT_GAP_OPTIONS } from '../../../shared/curb-gaps';
import type { Region, RegionKind } from '../../../shared/types';
import { REGION_RULE } from '../../../shared/types';
import { formatMiles, haversineMiles, type LatLon } from '../../../shared/geo';
import { REGION_STYLE } from '../../components/FrameView';
import { AnchorMap } from './AnchorMap';
import { KIND_TITLE, regionProblem, type EditorAction, type EditorState, type Tool } from './editor';

const KINDS: { kind: RegionKind; hint: string }[] = [
  { kind: 'parking', hint: 'Curb lane where cars park · 4 corners' },
  { kind: 'restricted', hint: 'Hydrant, driveway, bus stop, crosswalk' },
  { kind: 'ignore', hint: 'Hidden from analysis' },
  { kind: 'roadway', hint: 'Cars here are moving or double-parked' },
  { kind: 'sidewalk', hint: 'Context only' },
];

/** Anchors must stay near home (the server rejects anything further than 2 mi). */
const MAX_ANCHOR_MI = 2;

export function kindLabel(kind: RegionKind): string {
  const rule = REGION_RULE[kind];
  return rule ? `${KIND_TITLE[kind]} · ${rule}` : KIND_TITLE[kind];
}

export function ToolPicker({ tool, onTool }: { tool: Tool; onTool: (t: Tool) => void }) {
  return (
    <div className="cal-tools" role="radiogroup" aria-label="Drawing tool">
      <button type="button" role="radio" aria-checked={tool === 'select'} className="cal-tool" onClick={() => onTool('select')}>
        <MousePointer2 size={16} aria-hidden="true" />
        <span className="cal-tool-text">
          <b>Select & adjust</b>
          <small>Click a region, drag its corners</small>
        </span>
      </button>
      {KINDS.map(({ kind, hint }) => (
        <button key={kind} type="button" role="radio" aria-checked={tool === kind} className="cal-tool" onClick={() => onTool(kind)}>
          <i className={`cal-swatch cal-swatch-${kind}`} style={{ color: REGION_STYLE[kind].color }} aria-hidden="true" />
          <span className="cal-tool-text">
            <b>{kindLabel(kind)}</b>
            <small>{hint}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function RegionList({ state, dispatch }: { state: EditorState; dispatch: Dispatch<EditorAction> }) {
  if (state.regions.length === 0) return <p className="cal-empty">No regions yet. Start with a parking lane.</p>;
  return (
    <ul className="cal-list">
      {state.regions.map((r) => {
        const problem = regionProblem(r);
        return (
          <li key={r.id}>
            <button
              type="button"
              className="cal-list-item"
              aria-current={r.id === state.selectedId}
              onClick={() => dispatch({ type: 'select', id: r.id })}
            >
              <i className={`cal-swatch cal-swatch-${r.kind}`} style={{ color: REGION_STYLE[r.kind].color }} aria-hidden="true" />
              <span className="cal-list-text">
                <b>{r.label || KIND_TITLE[r.kind]}</b>
                <small>
                  {kindLabel(r.kind)}
                  {r.kind === 'parking' && r.capacity ? ` · ${r.capacity} cars` : ''}
                </small>
              </span>
              {problem && <span className="badge tone-red">Fix</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface FieldsProps {
  region: Region;
  dispatch: Dispatch<EditorAction>;
  camera: LatLon;
  home: LatLon;
}

/** Hydrant positions as typed text ("5, 31.4"); only valid numbers within the lane are kept. */
function HydrantsField({ value, laneM, onChange }: { value: number[]; laneM: number; onChange: (m: number[] | undefined) => void }) {
  const [text, setText] = useState(() => value.join(', '));
  return (
    <>
      <label className="field-label" htmlFor="region-hydrants">
        Hydrants <small>metres from the near end, e.g. 5, 31.4 · this lane is {laneM.toFixed(1)} m · 5 ft kept clear</small>
      </label>
      <input
        id="region-hydrants"
        className="field tabular"
        inputMode="decimal"
        placeholder="none"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const m = e.target.value
            .split(/[,\s]+/)
            .filter(Boolean)
            .map(Number)
            .filter((n) => Number.isFinite(n) && n >= 0 && n <= 250);
          onChange(m.length ? m.slice(0, 10) : undefined);
        }}
      />
    </>
  );
}

export function RegionFields({ region: r, dispatch, camera, home }: FieldsProps) {
  const update = (patch: Partial<Omit<Region, 'id' | 'kind'>>) => dispatch({ type: 'update', id: r.id, patch });
  const problem = regionProblem(r);
  const anchorMi = r.anchor ? haversineMiles(home, r.anchor) : null;
  const capacity = r.capacity ?? 0;

  return (
    <div className="cal-fields">
      <div className="cal-fields-head">
        <i className={`cal-swatch cal-swatch-${r.kind}`} style={{ color: REGION_STYLE[r.kind].color }} aria-hidden="true" />
        <span>{kindLabel(r.kind)}</span>
      </div>
      {problem && (
        <p className="banner tone-red cal-problem" role="alert">
          {problem}
        </p>
      )}

      <label className="field-label" htmlFor="region-label">
        Label
      </label>
      <input id="region-label" className="field" maxLength={80} value={r.label ?? ''} onChange={(e) => update({ label: e.target.value })} />

      {r.kind === 'parking' && (
        <>
          <label className="field-label" htmlFor="region-street">
            Street label <small>shown in the app</small>
          </label>
          <input
            id="region-street"
            className="field"
            maxLength={80}
            placeholder="W 181st St at Audubon Ave"
            value={r.streetLabel ?? ''}
            onChange={(e) => update({ streetLabel: e.target.value })}
          />

          <label className="field-label" htmlFor="region-capacity">
            Capacity <small>cars that fit bumper to bumper — check the tick marks</small>
          </label>
          <div className="cal-stepper">
            <button
              type="button"
              className="icon-btn is-small"
              aria-label="Fewer cars"
              disabled={capacity <= 1}
              onClick={() => update({ capacity: Math.max(1, capacity - 1) })}
            >
              <Minus size={16} aria-hidden="true" />
            </button>
            <input
              id="region-capacity"
              className="field tabular"
              type="number"
              inputMode="numeric"
              min={1}
              max={40}
              value={capacity || ''}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                update({ capacity: Number.isFinite(n) && n > 0 ? Math.min(40, n) : undefined });
              }}
            />
            <button
              type="button"
              className="icon-btn is-small"
              aria-label="More cars"
              disabled={capacity >= 40}
              onClick={() => update({ capacity: Math.min(40, capacity + 1) })}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>

          <HydrantsField key={r.id} value={r.hydrantsM ?? []} laneM={(capacity || 6) * DEFAULT_GAP_OPTIONS.slotM} onChange={(hydrantsM) => update({ hydrantsM })} />

          <span className="field-label">
            Map pin <small>optional · click where this lane is</small>
          </span>
          <AnchorMap key={r.id} camera={camera} home={home} anchor={r.anchor ?? null} onPick={(p) => update({ anchor: p })} />
          <div className="cal-anchor-row tabular">
            {r.anchor ? (
              <>
                <span>
                  {r.anchor.lat.toFixed(5)}, {r.anchor.lon.toFixed(5)} · {anchorMi !== null ? `${formatMiles(anchorMi)} from home` : ''}
                </span>
                <button type="button" className="btn-link" onClick={() => update({ anchor: undefined })}>
                  Clear
                </button>
              </>
            ) : (
              <span>Not set — the pin will sit next to the camera</span>
            )}
          </div>
          {anchorMi !== null && anchorMi > MAX_ANCHOR_MI && (
            <p className="cal-warn">That's more than {MAX_ANCHOR_MI} mi from home; the server will reject it.</p>
          )}
        </>
      )}

      <button type="button" className="btn btn-danger btn-sm cal-delete" onClick={() => dispatch({ type: 'delete', id: r.id })}>
        <Trash size={15} aria-hidden="true" />
        Delete region
      </button>
    </div>
  );
}
