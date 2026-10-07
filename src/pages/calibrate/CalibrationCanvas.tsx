// Drawing surface: the (frozen) frame with regions in an SVG overlay
// (normalized 0..1 coordinates), vertex handles as HTML elements so they keep
// their size and can be dragged with pointer capture, and on-canvas guidance.

import { useId, useRef, useState, type Dispatch, type PointerEvent, type MouseEvent } from 'react';
import type { Detection, Point, Region } from '../../../shared/types';
import { applyHomography, laneHomography } from '../../../shared/geometry';
import { pointInPolygon } from '../../../shared/geometry';
import { pointsAttr, REGION_STYLE } from '../../components/FrameView';
import '../../components/frame.css';
import { newRegionId, regionProblem, type EditorAction, type EditorState } from './editor';

interface Props {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  src: string | null;
  aspect: number;
  loadingText: string | null;
  test: Detection | null;
}

const PARKING_STEPS = ['near end, curb side', 'near end, traffic side', 'far end, traffic side', 'far end, curb side'];

function toPoint(e: { clientX: number; clientY: number }, el: HTMLElement): Point {
  const r = el.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}

/** Car-slot tick marks across a parking lane: u = k / capacity mapped back to the image. */
function laneTicks(r: Region): [Point, Point][] {
  const cap = r.capacity ?? 0;
  const H = cap > 1 ? laneHomography(r.points) : null;
  if (!H) return [];
  const out: [Point, Point][] = [];
  for (let k = 1; k < cap; k++) out.push([applyHomography(H.toImage, [k / cap, 0]), applyHomography(H.toImage, [k / cap, 1])]);
  return out;
}

export function CalibrationCanvas({ state, dispatch, src, aspect, loadingText, test }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const dragging = useRef<{ id: string; index: number; pointerId: number } | null>(null);
  const hatch = `cal-hatch-${useId().replace(/:/g, '')}`;
  const drawing = state.tool !== 'select';
  const selected = state.regions.find((r) => r.id === state.selectedId) ?? null;

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = surface.current;
    if (!el) return;
    const p = toPoint(e, el);
    if (drawing) {
      dispatch({ type: 'addPoint', point: p, newId: newRegionId(state.tool === 'select' ? 'parking' : state.tool) });
      return;
    }
    // Select the top-most region under the cursor (last drawn wins).
    const hit = [...state.regions].reverse().find((r) => pointInPolygon(p, r.points));
    dispatch({ type: 'select', id: hit?.id ?? null });
  };

  const onDoubleClick = () => {
    if (drawing && state.tool !== 'parking')
      dispatch({ type: 'finish', newId: newRegionId(state.tool === 'select' ? 'ignore' : state.tool) });
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = surface.current;
    if (!el) return;
    const d = dragging.current;
    if (d && d.pointerId === e.pointerId) {
      dispatch({ type: 'moveVertex', id: d.id, index: d.index, point: toPoint(e, el) });
      return;
    }
    if (drawing && state.draft.length) setHover(toPoint(e, el));
  };

  const startDrag = (e: PointerEvent<HTMLButtonElement>, id: string, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    surface.current?.setPointerCapture(e.pointerId);
    dragging.current = { id, index, pointerId: e.pointerId };
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current?.pointerId === e.pointerId) {
      dragging.current = null;
      if (surface.current?.hasPointerCapture(e.pointerId)) surface.current.releasePointerCapture(e.pointerId);
      // The click that follows a drag must not select/deselect.
      const swallow = (ev: Event) => ev.stopPropagation();
      surface.current?.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => surface.current?.removeEventListener('click', swallow, { capture: true }), 0);
    }
  };

  let guide: string;
  if (state.tool === 'parking') guide = `Click ${state.draft.length + 1} of 4: ${PARKING_STEPS[state.draft.length]}`;
  else if (drawing)
    guide = state.draft.length < 3 ? `Click to add points (${state.draft.length}/3 minimum)` : 'Double-click or press Enter to finish';
  else
    guide = selected
      ? 'Drag the handles to adjust · Delete removes the region'
      : 'Pick a region type to draw, or click a region to edit it';

  const draftColor = drawing ? REGION_STYLE[state.tool === 'select' ? 'parking' : state.tool].color : 'var(--blue)';
  const draftLine = hover && state.draft.length ? [...state.draft, hover] : state.draft;

  return (
    <div className="cal-canvas-wrap">
      {/* Above the frame (not on it) so it never hides a vertex. */}
      <div className={`cal-guide${drawing ? ' is-active' : ''}`} aria-live="polite">
        {guide}
      </div>
      <div
        ref={surface}
        className={`cal-canvas frame${drawing ? ' is-drawing' : ''}`}
        style={{ aspectRatio: String(aspect) }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        role="application"
        aria-label="Calibration canvas. Click to place points."
      >
        {src ? (
          <img className="frame-img" src={src} alt="Camera frame used for calibration" draggable={false} />
        ) : (
          <div className="frame-empty frame-error">{loadingText}</div>
        )}

        <svg className="frame-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <pattern id={hatch} width="0.025" height="0.025" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="0.025" height="0.025" fill="rgba(142,142,147,0.22)" />
              <line x1="0" y1="0" x2="0" y2="0.025" stroke="rgba(230,230,235,0.6)" strokeWidth="0.008" />
            </pattern>
          </defs>

          {state.regions.map((r) => {
            const isSel = r.id === state.selectedId;
            const invalid = regionProblem(r) !== null;
            return (
              <g
                key={r.id}
                className={`cal-region cal-${r.kind}${isSel ? ' is-selected' : ''}${invalid ? ' is-invalid' : ''}`}
                style={{ color: REGION_STYLE[r.kind].color }}
              >
                <polygon points={pointsAttr(r.points)} style={r.kind === 'ignore' ? { fill: `url(#${hatch})` } : undefined} />
                {r.kind === 'parking' && r.points.length === 4 && (
                  <>
                    {laneTicks(r).map(([a, b], i) => (
                      <line key={i} className="cal-tick" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
                    ))}
                    <line className="cal-curb" x1={r.points[0]![0]} y1={r.points[0]![1]} x2={r.points[3]![0]} y2={r.points[3]![1]} />
                  </>
                )}
              </g>
            );
          })}

          {test?.candidates.map((c, i) => (
            <polygon key={`g${i}`} points={pointsAttr(c.polygon)} className={`ov-gap ov-gap-${c.status}`} />
          ))}
          {test?.objects
            .filter((o) => ['car', 'truck', 'bus', 'motorcycle'].includes(o.label))
            .map((o, i) => (
              <rect
                key={`o${i}`}
                x={o.box.xmin}
                y={o.box.ymin}
                width={Math.max(0, o.box.xmax - o.box.xmin)}
                height={Math.max(0, o.box.ymax - o.box.ymin)}
                className={`ov-box ov-role-${o.role ?? 'ignored'}`}
              />
            ))}

          {draftLine.length > 0 && <polyline className="cal-draft" points={pointsAttr(draftLine)} style={{ stroke: draftColor }} />}
          {state.tool === 'parking' && state.draft.length === 3 && hover && (
            <line
              className="cal-draft is-closing"
              x1={hover[0]}
              y1={hover[1]}
              x2={state.draft[0]![0]}
              y2={state.draft[0]![1]}
              style={{ stroke: draftColor }}
            />
          )}
        </svg>

        {state.draft.map((p, i) => (
          <span
            key={`d${i}`}
            className="cal-vertex is-draft"
            style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%`, background: draftColor }}
          >
            {state.tool === 'parking' ? i + 1 : ''}
          </span>
        ))}

        {selected &&
          !drawing &&
          selected.points.map((p, i) => (
            <button
              key={`${selected.id}-${i}`}
              type="button"
              className={`cal-vertex${selected.kind === 'parking' ? ' is-numbered' : ''}`}
              style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%`, background: REGION_STYLE[selected.kind].color }}
              aria-label={`Vertex ${i + 1}${selected.kind === 'parking' ? `: ${PARKING_STEPS[i]}` : ''}`}
              onPointerDown={(e) => startDrag(e, selected.id, i)}
              onClick={(e) => e.stopPropagation()}
            >
              {selected.kind === 'parking' ? i + 1 : ''}
            </button>
          ))}
      </div>
      {state.tool === 'parking' && (
        <ol className="cal-steps" aria-label="Parking lane click order">
          {PARKING_STEPS.map((s, i) => (
            <li key={s} className={i === state.draft.length ? 'is-current' : i < state.draft.length ? 'is-done' : undefined}>
              <b>{i + 1}</b> {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
