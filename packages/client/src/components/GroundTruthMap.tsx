import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { BoundingBox, UnitState } from '@war-patrol/shared';
import { clamp, projectToUv, unprojectFromUv } from '@war-patrol/shared';

interface Props {
  area: BoundingBox;
  units: UnitState[];
}

const SIDE_COLORS: Record<string, string> = {
  blue: '#6ec8ff',
  red: '#ff8a6a',
  neutral: '#b8ffc8',
};

const W = 640;
const H = 420;
const ASPECT = W / H;

/** Discrete zoom multipliers (higher = closer). */
const ZOOM_STEPS = [1, 1.5, 2.25, 3.5, 5] as const;

/** Nice degree steps for lat/lon graticule (equirectangular / ARCH-SP-02). */
const GRID_STEPS_DEG = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30,
] as const;

function unitsSignature(units: UnitState[]): string {
  return units
    .map(
      (u) =>
        `${u.id}:${u.position.lat.toFixed(5)},${u.position.lon.toFixed(5)},${u.heading.toFixed(1)},${u.speed.toFixed(1)},${u.position.depth.toFixed(0)}`,
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

function niceGridStep(spanDeg: number, targetLines = 6): number {
  const raw = Math.max(spanDeg, 1e-9) / targetLines;
  for (const step of GRID_STEPS_DEG) {
    if (step >= raw) return step;
  }
  return GRID_STEPS_DEG[GRID_STEPS_DEG.length - 1]!;
}

/** Geographic tick values covering [min, max] at a fixed degree step. */
function geoTicks(min: number, max: number, step: number): number[] {
  if (!(step > 0) || !(max > min)) return [];
  const start = Math.ceil((min - 1e-12) / step) * step;
  const out: number[] = [];
  const decimals = step < 0.01 ? 4 : step < 0.1 ? 3 : step < 1 ? 2 : 1;
  for (let v = start; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(decimals + 2)));
    if (out.length > 48) break;
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

function GroundTruthMapInner({ area, units }: Props) {
  const unitIds = useMemo(() => [...units.map((u) => u.id)].sort().join(','), [units]);
  const areaKey = useMemo(() => areaSignature(area), [area]);
  const baseView = useMemo(() => fitUnitsView(units, area), [units, area]);

  const [zoomIdx, setZoomIdx] = useState(0);
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
    setZoomIdx(0);
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

  /** World-anchored graticule — same projection as units (pan/zoom lock). */
  const graticule = useMemo(() => {
    const latStep = niceGridStep(spanLat);
    const lonStep = niceGridStep(spanLon);
    const parallels = geoTicks(view.minLat, view.maxLat, latStep).map((lat) => {
      const { v } = projectToUv(lat, view.minLon, view);
      return { lat, y: v * H, label: formatLat(lat, latStep) };
    });
    const meridians = geoTicks(view.minLon, view.maxLon, lonStep).map((lon) => {
      const { u } = projectToUv(view.minLat, lon, view);
      return { lon, x: u * W, label: formatLon(lon, lonStep) };
    });
    return { parallels, meridians, latStep, lonStep };
  }, [view, spanLat, spanLon]);

  const markers = useMemo(
    () =>
      units.map((unit) => {
        const { u, v } = projectToUv(unit.position.lat, unit.position.lon, view);
        const x = u * W;
        const y = v * H;
        const color = SIDE_COLORS[unit.side] ?? '#c8ffd4';
        const rad = ((unit.heading - 90) * Math.PI) / 180;
        const tipLen = clamp(14 + zoom * 2, 14, 22);
        return {
          id: unit.id,
          name: unit.name.toUpperCase(),
          x,
          y,
          color,
          tipX: x + Math.cos(rad) * tipLen,
          tipY: y + Math.sin(rad) * tipLen,
          label: `${unit.speed.toFixed(0)} KN · ${unit.heading.toFixed(0)}°${
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
    setZoomIdx(0);
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

          {/* Parallels (constant latitude) — world space */}
          {graticule.parallels.map((p) => (
            <g key={`lat-${p.lat}`}>
              <line x1={0} y1={p.y} x2={W} y2={p.y} stroke="#1a4a28" strokeWidth={1} />
              <text
                x={8}
                y={clamp(p.y - 4, 12, H - 6)}
                fill="#5a9a68"
                fontSize={10}
                fontFamily="IBM Plex Mono, monospace"
              >
                {p.label}
              </text>
            </g>
          ))}

          {/* Meridians (constant longitude) — world space */}
          {graticule.meridians.map((m) => (
            <g key={`lon-${m.lon}`}>
              <line x1={m.x} y1={0} x2={m.x} y2={H} stroke="#1a4a28" strokeWidth={1} />
              <text
                x={clamp(m.x + 4, 4, W - 56)}
                y={H - 8}
                fill="#5a9a68"
                fontSize={10}
                fontFamily="IBM Plex Mono, monospace"
              >
                {m.label}
              </text>
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
            GROUND TRUTH · LAT/LON GRID
          </text>

          {markers
            .filter((m) => m.onPlot)
            .map((m) => (
              <g key={m.id}>
                <circle cx={m.x} cy={m.y} r={8} fill="none" stroke={m.color} strokeWidth={1.5} />
                <circle cx={m.x} cy={m.y} r={3} fill={m.color} />
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
  return unitsSignature(prev.units) === unitsSignature(next.units);
});
