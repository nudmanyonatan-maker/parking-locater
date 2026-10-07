// Calibration editor state: regions, selection, the polygon being drawn and
// the unsaved-changes flag. Pure reducer; ids are created by the caller so the
// reducer stays deterministic.

import type { Point, Region, RegionKind } from '../../../shared/types';
import { isConvexQuad } from '../../../shared/geometry';

export type Tool = 'select' | RegionKind;

export interface EditorState {
  regions: Region[];
  selectedId: string | null;
  tool: Tool;
  /** Vertices placed so far for a new region of kind `tool`. */
  draft: Point[];
  dirty: boolean;
}

export type EditorAction =
  | { type: 'reset'; regions: Region[] }
  | { type: 'tool'; tool: Tool }
  | { type: 'addPoint'; point: Point; newId: string }
  | { type: 'undoPoint' }
  | { type: 'finish'; newId: string }
  | { type: 'cancel' }
  | { type: 'select'; id: string | null }
  | { type: 'moveVertex'; id: string; index: number; point: Point }
  | { type: 'update'; id: string; patch: Partial<Omit<Region, 'id' | 'kind'>> }
  | { type: 'delete'; id: string }
  | { type: 'saved'; regions: Region[] };

/** Parking lanes need exactly 4 corners; other kinds 3..12 points (server limits). */
export const MAX_POINTS = 12;
/** Server limit per calibration. */
export const MAX_REGIONS = 20;
export const DEFAULT_CAPACITY = 6;
/** Clicks closer than this to the previous vertex are ignored (double-click finishing). */
const DUPLICATE_EPS = 0.008;

export const KIND_TITLE: Record<RegionKind, string> = {
  parking: 'Parking lane',
  restricted: 'Restricted',
  ignore: 'Ignore',
  roadway: 'Roadway',
  sidewalk: 'Sidewalk / curb',
};

export function initialEditor(regions: Region[]): EditorState {
  return { regions, selectedId: null, tool: 'select', draft: [], dirty: false };
}

export function newRegionId(kind: RegionKind): string {
  return `${kind}-${Math.random().toString(36).slice(2, 8)}`;
}

export function regionProblem(r: Region): string | null {
  if (r.kind === 'parking') {
    if (r.points.length !== 4) return 'A parking lane needs exactly 4 corners.';
    if (!isConvexQuad(r.points))
      return 'These corners cross over. Drag them so the lane is a simple 4-sided shape, in click order 1→2→3→4.';
    if (!r.capacity || r.capacity < 1 || r.capacity > 40) return 'Capacity must be 1–40 cars.';
  } else if (r.points.length < 3) {
    return 'Needs at least 3 points.';
  }
  return null;
}

function create(state: EditorState, kind: RegionKind, points: Point[], id: string): EditorState {
  const n = state.regions.filter((r) => r.kind === kind).length + 1;
  const region: Region =
    kind === 'parking'
      ? { id, kind, points, label: `${KIND_TITLE[kind]} ${n}`, capacity: DEFAULT_CAPACITY, streetLabel: '' }
      : { id, kind, points, label: `${KIND_TITLE[kind]} ${n}` };
  return { ...state, regions: [...state.regions, region], selectedId: id, tool: 'select', draft: [], dirty: true };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'reset':
      return initialEditor(action.regions);
    case 'saved':
      return { ...state, regions: action.regions, dirty: false };
    case 'tool':
      if (action.tool !== 'select' && state.regions.length >= MAX_REGIONS) return state;
      return { ...state, tool: action.tool, draft: [], selectedId: action.tool === 'select' ? state.selectedId : null };
    case 'addPoint': {
      if (state.tool === 'select') return state;
      const point: Point = [clamp01(action.point[0]), clamp01(action.point[1])];
      const last = state.draft[state.draft.length - 1];
      if (last && Math.hypot(last[0] - point[0], last[1] - point[1]) < DUPLICATE_EPS) return state;
      const draft = [...state.draft, point];
      if (state.tool === 'parking' && draft.length === 4) return create(state, 'parking', draft, action.newId);
      if (draft.length === MAX_POINTS) return create(state, state.tool, draft, action.newId);
      return { ...state, draft };
    }
    case 'undoPoint':
      return { ...state, draft: state.draft.slice(0, -1) };
    case 'finish':
      if (state.tool === 'select' || state.tool === 'parking' || state.draft.length < 3) return state;
      return create(state, state.tool, state.draft, action.newId);
    case 'cancel':
      return state.draft.length ? { ...state, draft: [] } : { ...state, tool: 'select', selectedId: null };
    case 'select':
      return { ...state, selectedId: action.id, tool: 'select', draft: [] };
    case 'moveVertex':
      return {
        ...state,
        dirty: true,
        regions: state.regions.map((r) =>
          r.id === action.id
            ? {
                ...r,
                points: r.points.map((p, i) => (i === action.index ? ([clamp01(action.point[0]), clamp01(action.point[1])] as Point) : p)),
              }
            : r,
        ),
      };
    case 'update':
      return { ...state, dirty: true, regions: state.regions.map((r) => (r.id === action.id ? { ...r, ...action.patch } : r)) };
    case 'delete':
      return {
        ...state,
        dirty: true,
        regions: state.regions.filter((r) => r.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };
  }
}

/** Shape the regions the way the API validates them (no empty optional strings). */
export function regionsForSave(regions: Region[]): Region[] {
  return regions.map((r) => {
    const out: Region = { id: r.id, kind: r.kind, points: r.points.map(([x, y]) => [round(x), round(y)] as Point) };
    if (r.label?.trim()) out.label = r.label.trim().slice(0, 80);
    if (r.kind === 'parking') {
      out.capacity = r.capacity ?? DEFAULT_CAPACITY;
      if (r.streetLabel?.trim()) out.streetLabel = r.streetLabel.trim().slice(0, 80);
      if (r.anchor) out.anchor = r.anchor;
      if (r.hydrantsM?.length) out.hydrantsM = r.hydrantsM;
    }
    return out;
  });
}

const round = (v: number) => Math.round(v * 10000) / 10000;
