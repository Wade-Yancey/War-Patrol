import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { BoundingBox, SensorDef, UnitState, UnitTrail } from '@war-patrol/shared';
import {
  METERS_PER_DEG_LAT,
  METERS_PER_NM,
  RADAR_MAX_RANGE_NM,
  clamp,
  metersPerDegLon,
  normalizeHeading,
  projectToUv,
  unprojectFromUv,
} from '@war-patrol/shared';

interface Props {
  area: BoundingBox;
  units: UnitState[];
  /** Prior-turn position trails (umpire ground truth). */
  trails?: UnitTrail[];
}

const SIDE_COLORS: Record<string, string> = {
  blue: '#6ec8ff',
  red: '#ff8a6a',
  civilian: '#c49bff',
  neutral: '#b8ffc8',
};

function unitAccent(unit: UnitState): string {
  const key = (unit.faction ?? unit.side ?? 'neutral').toString().toLowerCase();
  return SIDE_COLORS[key] ?? SIDE_COLORS.neutral!;
}

/** Wider / taller plot — full-width umpire ground-truth (Wade). */
const W = 960;
const H = 540;
const ASPECT = W / H;

/**
 * Compact north-up bearing rose inset (top-right).
 * Screen Y grows down; 0° = north = up (same convention as unit heading ticks).
 */
const COMPASS_CX = W - 78;
const COMPASS_CY = 78;
const COMPASS_R = 54;

type CompassTick = {
  deg: number;
  major: boolean;
  label: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lx: number;
  ly: number;
};

function polarAt(cx: number, cy: number, deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r };
}

/** Static rose geometry — built once; no per-frame work. */
const COMPASS_TICKS: CompassTick[] = (() => {
  const cardinals: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  const marks: CompassTick[] = [];
  for (let deg = 0; deg < 360; deg += 10) {
    const major = deg % 30 === 0;
    const tickLen = major ? 11 : 5;
    const outer = polarAt(COMPASS_CX, COMPASS_CY, deg, COMPASS_R);
    const inner = polarAt(COMPASS_CX, COMPASS_CY, deg, COMPASS_R - tickLen);
    const labelPt = polarAt(COMPASS_CX, COMPASS_CY, deg, COMPASS_R - 20);
    let label: string | null = null;
    if (cardinals[deg] != null) label = cardinals[deg]!;
    else if (deg % 30 === 0) label = String(deg);
    marks.push({
      deg,
      major,
      label,
      x1: inner.x,
      y1: inner.y,
      x2: outer.x,
      y2: outer.y,
      lx: labelPt.x,
      ly: labelPt.y,
    });
  }
  return marks;
})();

const COMPASS_N_TIP = polarAt(COMPASS_CX, COMPASS_CY, 0, COMPASS_R + 10);
const COMPASS_N_LEFT = polarAt(COMPASS_CX, COMPASS_CY, 0, COMPASS_R + 1);
const COMPASS_CROSS_N = polarAt(COMPASS_CX, COMPASS_CY, 0, COMPASS_R - 28);
const COMPASS_CROSS_S = polarAt(COMPASS_CX, COMPASS_CY, 180, COMPASS_R - 28);
const COMPASS_CROSS_E = polarAt(COMPASS_CX, COMPASS_CY, 90, COMPASS_R - 28);
const COMPASS_CROSS_W = polarAt(COMPASS_CX, COMPASS_CY, 270, COMPASS_R - 28);

/** Discrete zoom multipliers (higher = closer). Includes zoom-out below ×1. */
const ZOOM_STEPS = [0.35, 0.5, 0.7, 1, 1.5, 2.25, 3.5, 5] as const;
/** Default framing = fit units (×1). */
const DEFAULT_ZOOM_IDX = ZOOM_STEPS.indexOf(1);

/**
 * Fixed geographic graticule step (degrees). World-anchored with units; does not
 * retarget when the operator zooms (Wade). 0.1° ≈ 6′ — sensible for ~1° OAs.
 */
const GRID_STEP_DEG = 0.1;

/** Persist umpire map sensor-range overlay preference across reloads. */
const SENSOR_RANGES_STORAGE_KEY = 'wp-umpire-map-sensor-ranges';

function readShowSensorRanges(): boolean {
  try {
    return localStorage.getItem(SENSOR_RANGES_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeShowSensorRanges(on: boolean) {
  try {
    localStorage.setItem(SENSOR_RANGES_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* private mode / quota — ignore */
  }
}

/**
 * Installed sensors that already carry a detection radius.
 * Radar falls back to the stub max; other kinds only if maxRangeNm is set
 * (do not invent hydrophone/sonar ranges).
 */
function sensorRangesForUnit(unit: UnitState): { kind: SensorDef['kind']; rangeNm: number }[] {
  const sensors = unit.sensors;
  if (!sensors?.length) return [];
  const out: { kind: SensorDef['kind']; rangeNm: number }[] = [];
  for (const s of sensors) {
    if (s.kind === 'radar') {
      const rangeNm = s.maxRangeNm ?? RADAR_MAX_RANGE_NM;
      if (rangeNm > 0) out.push({ kind: 'radar', rangeNm });
      continue;
    }
    if (typeof s.maxRangeNm === 'number' && s.maxRangeNm > 0) {
      out.push({ kind: s.kind, rangeNm: s.maxRangeNm });
    }
  }
  return out;
}

function sensorsSignature(unit: UnitState): string {
  const sensors = unit.sensors;
  if (!sensors?.length) return '';
  return sensors.map((s) => `${s.kind}:${s.maxRangeNm ?? ''}`).join(',');
}

/** Equirectangular east/north circle → screen ellipse radii (ARCH-SP-02). */
function rangeBandRadiiPx(lat: number, rangeNm: number, view: BoundingBox): { rx: number; ry: number } {
  const meters = rangeNm * METERS_PER_NM;
  const dLat = meters / METERS_PER_DEG_LAT;
  const dLon = meters / metersPerDegLon(lat);
  const spanLat = view.maxLat - view.minLat || 1;
  const spanLon = view.maxLon - view.minLon || 1;
  return {
    rx: (dLon / spanLon) * W,
    ry: (dLat / spanLat) * H,
  };
}

function unitsSignature(units: UnitState[]): string {
  return units
    .map(
      (u) =>
        `${u.id}:${u.position.lat.toFixed(5)},${u.position.lon.toFixed(5)},${u.heading.toFixed(1)},${normalizeHeading(u.orderedCourse ?? u.heading).toFixed(1)},${u.speed.toFixed(1)},${u.position.depth.toFixed(0)},${u.type},${u.class},${u.name},${u.faction},${u.condition},${u.subsystems?.propulsion},${u.subsystems?.sensors},${u.flightLevel ?? ''},${sensorsSignature(u)}`,
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
  const [showSensorRanges, setShowSensorRanges] = useState(readShowSensorRanges);
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const toggleSensorRanges = useCallback(() => {
    setShowSensorRanges((prev) => {
      const next = !prev;
      writeShowSensorRanges(next);
      return next;
    });
  }, []);

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
        const color = unitAccent(unit);
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
        const color = unitAccent(unit);
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
          identity: `${unit.faction.toUpperCase()} · ${unit.class.toUpperCase()} · ${unit.type.toUpperCase()}${
            unit.condition === 'sunk'
              ? unit.type === 'Aircraft'
                ? ' · DESTROYED'
                : ' · SUNK'
              : ''
          }`,
          sunk: unit.condition === 'sunk',
          label: `${unit.speed.toFixed(0)} KN · HDG ${heading.toFixed(0)}° · CRS ${ordered.toFixed(0)}°${
            unit.type === 'Submarine' && unit.position.depth > 0
              ? ` · ${unit.position.depth.toFixed(0)} M`
              : unit.type === 'Aircraft'
                ? ` · FL ${(unit.flightLevel ?? 'medium').toUpperCase()}`
                : ''
          }`,
          onPlot: u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05,
        };
      }),
    [units, view, zoom],
  );

  /** Optional sensor detection radii — memoized; skipped when overlay is off. */
  const rangeBands = useMemo(() => {
    if (!showSensorRanges) return [];
    const bands: {
      key: string;
      x: number;
      y: number;
      rx: number;
      ry: number;
      color: string;
      label: string;
      labelY: number;
    }[] = [];
    for (const unit of units) {
      const ranges = sensorRangesForUnit(unit);
      if (!ranges.length) continue;
      const { u, v } = projectToUv(unit.position.lat, unit.position.lon, view);
      const x = u * W;
      const y = v * H;
      const color = unitAccent(unit);
      for (const r of ranges) {
        const { rx, ry } = rangeBandRadiiPx(unit.position.lat, r.rangeNm, view);
        // Cull rings that cannot intersect the plot (cheap).
        if (x + rx < -8 || x - rx > W + 8 || y + ry < -8 || y - ry > H + 8) continue;
        bands.push({
          key: `${unit.id}-${r.kind}-${r.rangeNm}`,
          x,
          y,
          rx,
          ry,
          color,
          label: `${r.kind.toUpperCase()} ${r.rangeNm} NM`,
          labelY: y + ry + 11,
        });
      }
    }
    return bands;
  }, [units, view, showSensorRanges]);

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
      <div className="map-toolbar" role="toolbar" aria-label="Map scale, pan, and overlays">
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
        <button
          type="button"
          className={showSensorRanges ? 'map-toggle-on' : undefined}
          aria-pressed={showSensorRanges}
          aria-label="Toggle sensor detection range bands"
          onClick={toggleSensorRanges}
        >
          Ranges
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
          aria-label="Ground truth lat/lon map with true north compass — drag to pan"
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
            GROUND TRUTH · LAT/LON · {GRID_STEP_DEG}° GRID · TRAILS · TRUE N
            {showSensorRanges ? ' · RANGES' : ''}
          </text>

          {/* Sensor detection radii — under trails/units; only when toggle is on */}
          {rangeBands.map((b) => (
            <g key={b.key} pointerEvents="none">
              <ellipse
                cx={b.x}
                cy={b.y}
                rx={b.rx}
                ry={b.ry}
                fill={b.color}
                fillOpacity={0.04}
                stroke={b.color}
                strokeWidth={1.25}
                strokeOpacity={0.55}
                strokeDasharray="5 4"
              />
              <text
                x={b.x}
                y={clamp(b.labelY, 12, H - 4)}
                textAnchor="middle"
                fill={b.color}
                fillOpacity={0.75}
                fontSize={9}
                fontFamily="IBM Plex Mono, monospace"
              >
                {b.label}
              </text>
            </g>
          ))}

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
                <circle
                  cx={m.x}
                  cy={m.y}
                  r={8}
                  fill="none"
                  stroke={m.color}
                  strokeWidth={1.5}
                  strokeOpacity={m.sunk ? 0.35 : 1}
                />
                <circle cx={m.x} cy={m.y} r={3} fill={m.color} opacity={m.sunk ? 0.35 : 1} />
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
                  y={m.y + 4}
                  fill="#5a9a68"
                  fontSize={9}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {m.identity}
                </text>
                <text
                  x={m.x + 12}
                  y={m.y + 16}
                  fill="#5a9a68"
                  fontSize={10}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {m.label}
                </text>
              </g>
            ))}

          {/* North-up bearing rose — corner inset so units stay readable */}
          <g className="map-compass" pointerEvents="none" aria-hidden="true">
            <circle
              cx={COMPASS_CX}
              cy={COMPASS_CY}
              r={COMPASS_R + 14}
              fill="#041208"
              fillOpacity={0.82}
              stroke="#1a4a28"
              strokeWidth={1}
            />
            <circle
              cx={COMPASS_CX}
              cy={COMPASS_CY}
              r={COMPASS_R}
              fill="none"
              stroke="#2a6a3c"
              strokeWidth={1.25}
            />
            <line
              x1={COMPASS_CROSS_N.x}
              y1={COMPASS_CROSS_N.y}
              x2={COMPASS_CROSS_S.x}
              y2={COMPASS_CROSS_S.y}
              stroke="#1a4a28"
              strokeWidth={1}
            />
            <line
              x1={COMPASS_CROSS_W.x}
              y1={COMPASS_CROSS_W.y}
              x2={COMPASS_CROSS_E.x}
              y2={COMPASS_CROSS_E.y}
              stroke="#1a4a28"
              strokeWidth={1}
            />
            {COMPASS_TICKS.map((t) => (
              <g key={`cmp-${t.deg}`}>
                <line
                  x1={t.x1}
                  y1={t.y1}
                  x2={t.x2}
                  y2={t.y2}
                  stroke={t.deg === 0 ? '#7dff9a' : '#3dff6a'}
                  strokeWidth={t.major ? 1.5 : 1}
                  strokeOpacity={t.major ? 0.9 : 0.45}
                />
                {t.label && (
                  <text
                    x={t.lx}
                    y={t.ly}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={t.deg === 0 ? '#7dff9a' : '#5a9a68'}
                    fontSize={t.deg % 90 === 0 ? 11 : 8}
                    fontFamily="IBM Plex Mono, monospace"
                    fontWeight={t.deg === 0 ? 700 : 400}
                  >
                    {t.label}
                  </text>
                )}
              </g>
            ))}
            <polygon
              points={`${COMPASS_N_TIP.x},${COMPASS_N_TIP.y} ${COMPASS_N_TIP.x - 5},${COMPASS_N_LEFT.y} ${COMPASS_N_TIP.x + 5},${COMPASS_N_LEFT.y}`}
              fill="#7dff9a"
              fillOpacity={0.95}
            />
            <circle cx={COMPASS_CX} cy={COMPASS_CY} r={2.5} fill="#3dff6a" />
            <text
              x={COMPASS_CX}
              y={COMPASS_CY + COMPASS_R + 11}
              textAnchor="middle"
              fill="#5a9a68"
              fontSize={8}
              fontFamily="IBM Plex Mono, monospace"
            >
              TRUE °
            </text>
          </g>
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
