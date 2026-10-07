// Camera frame with an optional SVG overlay in normalized image coordinates
// (viewBox 0..1, stretched to the image). Strokes use non-scaling-stroke so
// line widths stay in screen pixels however large the frame is drawn.

import { ImageOff } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { DetectedObject, ParkingCandidate, Point, Region, RegionKind } from '../../shared/types';
import './frame.css';

export interface FrameOverlay {
  objects?: DetectedObject[];
  candidates?: Pick<ParkingCandidate, 'polygon' | 'status'>[];
  regions?: Region[];
  /** Hydrants on the curb and their no-parking zones (from hydrantMarks). */
  hydrants?: { point: Point; zone: Point[] }[];
}

interface Props {
  src: string | null;
  alt: string;
  overlay?: FrameOverlay | null;
  /** Width / height. Frames are 352x240 (a few cameras send 720x480). */
  aspect?: number;
  loading?: boolean;
  /** Shown instead of the image when there is no frame at all. */
  errorText?: string | null;
  className?: string;
  children?: ReactNode;
}

const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle']);

export const REGION_STYLE: Record<RegionKind, { color: string; label: string }> = {
  parking: { color: 'var(--green)', label: 'Parking lane' },
  restricted: { color: 'var(--red)', label: 'Restricted' },
  ignore: { color: 'var(--gray)', label: 'Ignore' },
  roadway: { color: 'var(--blue)', label: 'Roadway' },
  sidewalk: { color: 'var(--purple)', label: 'Sidewalk / curb' },
};

export const pointsAttr = (pts: Point[]) => pts.map(([x, y]) => `${x},${y}`).join(' ');

export function FrameView({ src, alt, overlay, aspect = 352 / 240, loading, errorText, className = '', children }: Props) {
  return (
    <div className={`frame ${className}`} style={{ aspectRatio: String(aspect) }}>
      {src ? (
        <img className="frame-img" src={src} alt={alt} draggable={false} />
      ) : loading || !errorText ? (
        <div className="frame-empty skeleton" aria-label="Loading camera image" />
      ) : (
        <div className="frame-empty frame-error">
          <ImageOff size={22} aria-hidden="true" />
          <span>{errorText}</span>
        </div>
      )}
      {overlay && src && <OverlaySvg overlay={overlay} />}
      {children}
    </div>
  );
}

function OverlaySvg({ overlay }: { overlay: FrameOverlay }) {
  const hatch = `hatch-${useId().replace(/:/g, '')}`;
  const vehicles = (overlay.objects ?? []).filter((o) => VEHICLES.has(o.label));
  return (
    <svg className="frame-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id={hatch} width="0.025" height="0.025" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="0.025" height="0.025" fill="rgba(142,142,147,0.18)" />
          <line x1="0" y1="0" x2="0" y2="0.025" stroke="rgba(220,220,225,0.55)" strokeWidth="0.008" />
        </pattern>
      </defs>
      {(overlay.regions ?? []).map((r) => (
        <polygon
          key={r.id}
          points={pointsAttr(r.points)}
          className={`ov-region ov-${r.kind}`}
          // Inline style (not the fill attribute) so it wins over the class's fill.
          style={{ stroke: REGION_STYLE[r.kind].color, fill: r.kind === 'ignore' ? `url(#${hatch})` : undefined }}
        />
      ))}
      {(overlay.hydrants ?? []).map((h, i) => (
        <g key={`h${i}`} className="ov-hydrant">
          <polygon points={pointsAttr(h.zone)} className="ov-hydrant-zone" />
          <line x1={h.point[0]} y1={h.point[1]} x2={h.point[0]} y2={h.point[1] - 0.035} className="ov-hydrant-post" />
        </g>
      ))}
      {(overlay.candidates ?? []).map((c, i) => (
        <polygon key={`c${i}`} points={pointsAttr(c.polygon)} className={`ov-gap ov-gap-${c.status}`} />
      ))}
      {vehicles.map((o, i) => (
        <rect
          key={`o${i}`}
          x={o.box.xmin}
          y={o.box.ymin}
          width={Math.max(0, o.box.xmax - o.box.xmin)}
          height={Math.max(0, o.box.ymax - o.box.ymin)}
          className={`ov-box ov-role-${o.role ?? 'ignored'}`}
        />
      ))}
    </svg>
  );
}

/** Small key explaining overlay colors. */
export function OverlayLegend({ showRegions = true }: { showRegions?: boolean }) {
  return (
    <ul className="legend" aria-label="Overlay key">
      <li>
        <i className="lg-box lg-parked" />
        Parked
      </li>
      <li>
        <i className="lg-box lg-roadway" />
        In roadway
      </li>
      <li>
        <i className="lg-box lg-ignored" />
        Ignored
      </li>
      <li>
        <i className="lg-fill lg-gap" />
        Open curb
      </li>
      {showRegions && (
        <li>
          <i className="lg-box lg-lane" />
          Parking lane
        </li>
      )}
      {showRegions && (
        <li>
          <i className="lg-box lg-restricted" />
          Restricted
        </li>
      )}
    </ul>
  );
}
