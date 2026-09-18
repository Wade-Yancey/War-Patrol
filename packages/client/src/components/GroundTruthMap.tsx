import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { BoundingBox, UnitState, UnitTrail } from '@war-patrol/shared';
import { clamp, normalizeHeading, projectToUv, unprojectFromUv } from '@war-patrol/shared';

interface Props {
  area: BoundingBox;
  units: UnitState[];
  /** Prior-turn position trails (umpire ground truth). */
  trails?: UnitTrail[];
}

const SIDE_COLORS: Record<string, string> = {
  blue: '#6ec8ff',
  red: '#ff8a6a',
  neutral: '#b8ffc8',
};

const W = 640;
const H = 420;
const ASPECT = W / H;

/** Discrete zoom multipliers (higher = closer). Includes zoom-out below ×1. */
const ZOOM_STEPS = [0.35, 0.5, 0.7, 1, 1.5, 2.25, 3.5, 5] as const;
/** Default framing = fit units (×1). */
const DEFAULT_ZOOM_IDX = ZOOM_STEPS.indexOf(1);

/**
 * Fixed geographic graticule step (degrees). World-anchored with units; does not
 * retarget when the operator zooms (Wade). 0.1° ≈ 6′ — sensible for ~1° OAs.
 */
const GRID_STEP_DEG = 0.1;

function unitsSignature(units: UnitState[]): string {
  return units
    .map(
      (u) =>
        `${u.id}:${u.position.lat.toFixed(5)},${u.position.lon.toFixed(5)},${u.heading.toFixed(1)},${normalizeHeading(u.orderedCourse ?? u.heading).toFixed(1)},${u.speed.toFixed(1)},${u.position.depth.toFixed(0)}`,
    )
    .join('|');
}

function trailsSignature(trails: UnitTrail[] | undefined): string {
  if (!trails?.length) return '';
  return trails
    .map(
      (t) =>
        `${t.unitId}:${t.points.map((p) => `${p.turnNumber}@${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('>')}`,
    )
    .join('|');
}

function areaSignature(area: BoundingBox): string {
  return `${area.minLat},${area.maxLat},${area.minLon},${area.maxLon}`;
}

/** Pad and aspect-correct a lat/lon box to the plot aspect ratio. */
function normalizeViewBox(
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number,
  pad = 1.35,
): BoundingBox {
  let midLat = (minLat + maxLat) / 2;
  let midLon = (minLon + maxLon) / 2;
  let dLat = Math.max((maxLat - minLat) * pad, 0.06);
  let dLon = Math.max((maxLon - minLon) * pad, 0.06);
  if (dLon / dLat < ASPECT) dLon = dLat * ASPECT;
  else dLat = dLon / ASPECT;
  return {
    minLat: midLat - dLat / 2,
    maxLat: midLat + dLat / 2,
    minLon: midLon - dLon / 2,
    maxLon: midLon + dLon / 2,
  };
}

/** Default framing: bounding box of units (with padding), else operating area. */
function fitUnitsView(units: UnitState[], area: BoundingBox): BoundingBox {
  if (units.length === 0) {
    return normalizeViewBox(area.minLat, area.maxLat, area.minLon, area.maxLon, 1);
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const u of units) {
    minLat = Math.min(minLat, u.position.lat);
    maxLat = Math.max(maxLat, u.position.lat);
    minLon = Math.min(minLon, u.position.lon);
    maxLon = Math.max(maxLon, u.position.lon);
  }
  return normalizeViewBox(minLat, maxLat, minLon, maxLon);
}

function scaleViewAroundCenter(base: BoundingBox, zoom: number, panLat: number, panLon: number): BoundingBox {
  const midLat = (base.minLat + base.maxLat) / 2 + panLat;
  const midLon = (base.minLon + base.maxLon) / 2 + panLon;
  const dLat = (base.maxLat - base.minLat) / zoom;
  const dLon = (base.maxLon - base.minLon) / zoom;
  return {
    minLat: midLat - dLat / 2,
    maxLat: midLat + dLat / 2,
    minLon: midLon - dLon / 2,
    maxLon: midLon + dLon / 2,
  };
}

/** Geographic tick values covering [min, max] at a fixed degree step. */
function geoTicks(min: number, max: number, step: number): number[] {
  if (!(step > 0) || !(max > min)) return [];
  const start = Math.ceil((min - 1e-12) / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(6)));
    if (out.length > 96) break;
  }
  return out;
}

function formatLat(lat: number, step: number): string {
  const abs = Math.abs(lat);
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const hemi = lat >= 0 ? 'N' : 'S';
  return `${abs.toFixed(decimals)}°${hemi}`;
}

function formatLon(lon: number, step: number): string {
  const abs = Math.abs(lon);
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const hemi = lon >= 0 ? 'E' : 'W';
  return `${abs.toFixed(decimals)}°${hemi}`;
}

function formatCursor(lat: number, lon: number): string {
  return `${formatLat(lat, 0.001)}  ${formatLon(lon, 0.001)}`;
}

/** Label every line, or every major (0.5°) when the view is dense. */
function shouldLabelGridValue(value: number, step: number, tickCount: number): boolean {
  if (tickCount <= 14) return true;
  const major = Math.max(step, 0.5);
  const q = value / major;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

function GroundTruthMapInner({ area, units, trails = [] }: Props) {
  const unitIds = useMemo(() => [...units.map((u) => u.id)].sort().join(','), [units]);
  const areaKey = useMemo(() => areaSignature(area), [area]);
  const baseView = useMemo(() => fitUnitsView(units, area), [units, area]);
  const trailByUnit = useMemo(() => {
    const map = new Map<string, UnitTrail>();
    for (const t of trails) map.set(t.unitId, t);
    return map;
  }, [trails]);

  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM_IDX);
  const [panLat, setPanLat] = useState(0);
  const [panLon, setPanLon] = useState(0);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // Reset camera when the unit set or operating area changes (not on every move).
  useEffect(() => {
    setZoomIdx(DEFAULT_ZOOM_IDX);
    setPanLat(0);
    setPanLon(0);
    setCursor(null);
  }, [unitIds, areaKey]);

  const zoom = ZOOM_STEPS[zoomIdx] ?? 1;
  const view = useMemo(
    () => scaleViewAroundCenter(baseView, zoom, panLat, panLon),
    [baseView, zoom, panLat, panLon],
  );

  const spanLat = view.maxLat - view.minLat;
  const spanLon = view.maxLon - view.minLon;

  /** Fixed-step world graticule — same projection as units; step never changes with zoom. */
  const graticule = useMemo(() => {
    const step = GRID_STEP_DEG;
    const latTicks = geoTicks(view.minLat, view.maxLat, step);
    const lonTicks = geoTicks(view.minLon, view.maxLon, step);
    const parallels = latTicks.map((lat) => {
      const { v } = projectToUv(lat, view.minLon, view);
      return {
        lat,
        y: v * H,
        label: formatLat(lat, step),
        showLabel: shouldLabelGridValue(lat, step, latTicks.length),
      };
    });
    const meridians = lonTicks.map((lon) => {
      const { u } = projectToUv(view.minLat, lon, view);
      return {
        lon,
        x: u * W,
        label: formatLon(lon, step),
        showLabel: shouldLabelGridValue(lon, step, lonTicks.length),
      };
    });
    return { parallels, meridians, step };
  }, [view]);

  const trailPolylines = useMemo(() => {
    return units
      .map((unit) => {
        const trail = trailByUnit.get(unit.id);
        if (!trail || trail.points.length < 2) return null;
        const color = SIDE_COLORS[unit.side] ?? '#c8ffd4';
        const pts = trail.points.map((p) => {
          const { u, v } = projectToUv(p.lat, p.lon, view);
          return { x: u * W, y: v * H, u, v };
        });
        // Skip if entirely off-plot (cheap cull)
        const anyOn = pts.some((p) => p.u >= -0.08 && p.u <= 1.08 && p.v >= -0.08 && p.v <= 1.08);
        if (!anyOn) return null;
        return {
          id: unit.id,
          color,
          points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        };
      })
      .filter((x): x is { id: string; color: string; points: string } => Boolean(x));
  }, [units, trailByUnit, view]);

  const markers = useMemo(
    () =>
      units.map((unit) => {
        const { u, v } = projectToUv(unit.position.lat, unit.position.lon, view);
        const x = u * W;
        const y = v * H;
        const color = SIDE_COLORS[unit.side] ?? '#c8ffd4';
        const heading = normalizeHeading(unit.heading);
        const ordered = normalizeHeading(unit.orderedCourse ?? unit.heading);
        const hRad = ((heading - 90) * Math.PI) / 180;
        const oRad = ((ordered - 90) * Math.PI) / 180;
        const tipLen = clamp(14 + zoom * 2, 14, 22);
        const courseLen = tipLen + 10;
        const courseDelta = Math.abs(((ordered - heading + 540) % 360) - 180);
        return {
          id: unit.id,
          name: unit.name.toUpperCase(),
          x,
          y,
          color,
          tipX: x + Math.cos(hRad) * tipLen,
          tipY: y + Math.sin(hRad) * tipLen,
          courseX: x + Math.cos(oRad) * courseLen,
          courseY: y + Math.sin(oRad) * courseLen,
          showOrdered: courseDelta > 0.5,
          label: `${unit.speed.toFixed(0)} KN · HDG ${heading.toFixed(0)}° · CRS ${ordered.toFixed(0)}°${
            unit.position.depth > 0 ? ` · ${unit.position.depth.toFixed(0)} M` : ''
          }`,
          onPlot: u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05,
        };
      }),
    [units, view, zoom],
  );

  /** Operating-area outline in the same world projection (when it intersects the view). */
  const areaOutline = useMemo(() => {
    const corners = [
      projectToUv(area.maxLat, area.minLon, view),
      projectToUv(area.maxLat, area.maxLon, view),
      projectToUv(area.minLat, area.maxLon, view),
      projectToUv(area.minLat, area.minLon, view),
    ];
    return corners.map((c) => `${c.u * W},${c.v * H}`).join(' ');
  }, [area, view]);

  const zoomIn = () => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1));
  const zoomOut = () => setZoomIdx((i) => Math.max(0, i - 1));
  const recenter = () => {
    setZoomIdx(DEFAULT_ZOOM_IDX);
    setPanLat(0);
    setPanLon(0);
  };

  const clientToLatLon = useCallback(
    (clientX: number, clientY: number): { lat: number; lon: number } | null => {
      const frame = frameRef.current;
      if (!frame) return null;
      const rect = frame.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const u = (clientX - rect.left) / rect.width;
      const v = (clientY - rect.top) / rect.height;
      return unprojectFromUv(u, v, view);
    },
    [view],
  );

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const geo = clientToLatLon(e.clientX, e.clientY);
      if (geo) setCursor(geo);

      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      setPanLon((p) => p - (dx / rect.width) * spanLon);
      setPanLat((p) => p + (dy / rect.height) * spanLat);
    },
    [clientToLatLon, spanLat, spanLon],
  );

  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
  }, []);

  const onPointerLeave = useCallback(() => {
    if (!dragRef.current) setCursor(null);
  }, []);

  return (
    <div className="map-frame">
      <div className="map-toolbar" role="toolbar" aria-label="Map scale and pan">
        <button type="button" onClick={zoomOut} disabled={zoomIdx <= 0} aria-label="Zoom out">
          −
        </button>
        <span className="mono muted map-zoom-readout">×{zoom.toFixed(zoom % 1 ? 2 : 0)}</span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoomIdx >= ZOOM_STEPS.length - 1}
          aria-label="Zoom in"
        >
          +
        </button>
        <button type="button" onClick={recenter} aria-label="Recenter on units">
          Recenter
        </button>
        <span className="mono muted map-cursor-readout" aria-live="polite">
          {cursor ? formatCursor(cursor.lat, cursor.lon) : 'LAT/LON · HOVER PLOT'}
        </span>
      </div>

      <div
        ref={frameRef}
        className="map-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={onPointerLeave}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Ground truth lat/lon map — drag to pan"
        >
          <rect width={W} height={H} fill="#061a0e" />

          {/* Parallels (constant latitude) — world space, fixed ° step */}
          {graticule.parallels.map((p) => (
            <g key={`lat-${p.lat}`}>
              <line x1={0} y1={p.y} x2={W} y2={p.y} stroke="#1a4a28" strokeWidth={1} />
              {p.showLabel && (
                <text
                  x={8}
                  y={clamp(p.y - 4, 12, H - 6)}
                  fill="#5a9a68"
                  fontSize={10}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {p.label}
                </text>
              )}
            </g>
          ))}

          {/* Meridians (constant longitude) — world space, fixed ° step */}
          {graticule.meridians.map((m) => (
            <g key={`lon-${m.lon}`}>
              <line x1={m.x} y1={0} x2={m.x} y2={H} stroke="#1a4a28" strokeWidth={1} />
              {m.showLabel && (
                <text
                  x={clamp(m.x + 4, 4, W - 56)}
                  y={H - 8}
                  fill="#5a9a68"
                  fontSize={10}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {m.label}
                </text>
              )}
            </g>
          ))}

          <polygon
            points={areaOutline}
            fill="none"
            stroke="#2a6a3c"
            strokeWidth={1.25}
            strokeDasharray="6 4"
            opacity={0.7}
          />

          <g stroke="#3dff6a" strokeWidth={1.5} opacity={0.45}>
            <path d="M8 8 H28 M8 8 V28" fill="none" />
            <path d={`M${W - 8} 8 H${W - 28} M${W - 8} 8 V28`} fill="none" />
            <path d={`M8 ${H - 8} H28 M8 ${H - 8} V${H - 28}`} fill="none" />
            <path d={`M${W - 8} ${H - 8} H${W - 28} M${W - 8} ${H - 8} V${H - 28}`} fill="none" />
          </g>

          <text x={12} y={18} fill="#5a9a68" fontSize={10} fontFamily="IBM Plex Mono, monospace">
            GROUND TRUTH · LAT/LON · {GRID_STEP_DEG}° GRID · TRAILS
          </text>

          {/* Trails under units — simple polylines (CRT-friendly, cheap) */}
          {trailPolylines.map((t) => (
            <polyline
              key={`trail-${t.id}`}
              points={t.points}
              fill="none"
              stroke={t.color}
              strokeWidth={1.25}
              strokeOpacity={0.55}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {markers
            .filter((m) => m.onPlot)
            .map((m) => (
              <g key={m.id}>
                <circle cx={m.x} cy={m.y} r={8} fill="none" stroke={m.color} strokeWidth={1.5} />
                <circle cx={m.x} cy={m.y} r={3} fill={m.color} />
                {m.showOrdered && (
                  <line
                    x1={m.x}
                    y1={m.y}
                    x2={m.courseX}
                    y2={m.courseY}
                    stroke={m.color}
                    strokeWidth={1.25}
                    strokeOpacity={0.55}
                    strokeDasharray="4 3"
                    strokeLinecap="square"
                  />
                )}
                <line
                  x1={m.x}
                  y1={m.y}
                  x2={m.tipX}
                  y2={m.tipY}
                  stroke={m.color}
                  strokeWidth={2}
                  strokeLinecap="square"
                />
                <text
                  x={m.x + 12}
                  y={m.y - 10}
                  fill="#7dff9a"
                  fontSize={11}
                  fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
                >
                  {m.name}
                </text>
                <text
                  x={m.x + 12}
                  y={m.y + 5}
                  fill="#5a9a68"
                  fontSize={10}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {m.label}
                </text>
              </g>
            ))}
        </svg>
      </div>
    </div>
  );
}

export const GroundTruthMap = memo(GroundTruthMapInner, (prev, next) => {
  if (
    prev.area.minLat !== next.area.minLat ||
    prev.area.maxLat !== next.area.maxLat ||
    prev.area.minLon !== next.area.minLon ||
    prev.area.maxLon !== next.area.maxLon
  ) {
    return false;
  }
  if (trailsSignature(prev.trails) !== trailsSignature(next.trails)) return false;
  return unitsSignature(prev.units) === unitsSignature(next.units);
});
