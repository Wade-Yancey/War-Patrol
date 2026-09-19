import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type {
  BoundingBox,
  DepthChargeTrack,
  SensorDef,
  TorpedoTrack,
  UnitState,
  UnitTrail,
} from '@war-patrol/shared';
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
  /** Full-truth torpedo tracks (launch → path → tip). */
  torpedoes?: TorpedoTrack[];
  /** Full-truth depth-charge tracks (drop → sink/detonate). */
  depthCharges?: DepthChargeTrack[];
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
 * Compact north-up bearing rose inset (bottom-left).
 * Keeps the plot center and unit labels clear; screen Y grows down; 0° = north = up.
 */
const COMPASS_CX = 72;
const COMPASS_CY = H - 72;
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
 * (do not invent hydrophone / active-sonar ranges).
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

function weaponsSignature(
  torpedoes: TorpedoTrack[] | undefined,
  depthCharges: DepthChargeTrack[] | undefined,
): string {
  const t = (torpedoes ?? [])
    .map(
      (f) =>
        `${f.id}:${f.status}:${f.position.lat.toFixed(5)},${f.position.lon.toFixed(5)}:${(f.path ?? []).length}`,
    )
    .join('|');
  const d = (depthCharges ?? [])
    .map(
      (c) =>
        `${c.id}:${c.status}:${c.position.lat.toFixed(5)},${c.position.lon.toFixed(5)},${c.position.depth.toFixed(0)}`,
    )
    .join('|');
  return `${t}#${d}`;
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

function GroundTruthMapInner({
  area,
  units,
  trails = [],
  torpedoes = [],
  depthCharges = [],
}: Props) {
  const unitIds = useMemo(() => [...units.map((u) => u.id)].sort().join(','), [units]);
  const areaKey = useMemo(() => areaSignature(area), [area]);
  const baseView = useMemo(() => fitUnitsView(units, area), [units, area]);
  const trailByUnit = useMemo(() => {
    const map = new Map<string, UnitTrail>();
    for (const t of trails) map.set(t.unitId, t);
    return map;
  }, [trails]);

  const unitAccentById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of units) m.set(u.id, unitAccent(u));
    return m;
  }, [units]);
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM_IDX);
  const [panLat, setPanLat] = useState(0);
  const [panLon, setPanLon] = useState(0);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [showSensorRanges, setShowSensorRanges] = useState(() => readShowSensorRanges());
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
        const last = pts[pts.length - 1]!;
        const prev = pts[pts.length - 2]!;
        return {
          id: unit.id,
          color,
          points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
          /** Last inbound screen delta — keep unit labels off the trail. */
          inboundDx: last.x - prev.x,
        };
      })
      .filter(
        (x): x is { id: string; color: string; points: string; inboundDx: number } => Boolean(x),
      );
  }, [units, trailByUnit, view]);

  const trailInboundDx = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trailPolylines) map.set(t.id, t.inboundDx);
    return map;
  }, [trailPolylines]);

  /**
   * Weapon GT overlays — launch origin pip, path polyline, tip/end marker.
   * Torpedoes: dashed amber run track. Depth charges: cyan drop + detonation burst.
   */
  const weaponOverlays = useMemo(() => {
    const toXy = (lat: number, lon: number) => {
      const { u, v } = projectToUv(lat, lon, view);
      return { x: u * W, y: v * H, u, v };
    };

    const fish = torpedoes.map((t) => {
      const color = unitAccentById.get(t.firerUnitId) ?? '#ffc857';
      const launch = t.launchPosition ?? t.path?.[0] ?? t.position;
      const pathPts = (t.path?.length ? t.path : [{ lat: launch.lat, lon: launch.lon }]).map((p) =>
        toXy(p.lat, p.lon),
      );
      const tip = toXy(t.position.lat, t.position.lon);
      const origin = toXy(launch.lat, launch.lon);
      const hRad = ((normalizeHeading(t.heading) - 90) * Math.PI) / 180;
      // Heading pip only while running — hit/expired tip stops at end position.
      const tipLen = t.status === 'running' ? 10 : 0;
      const statusLabel =
        t.status === 'running'
          ? `FISH · ${t.remainingRunNm.toFixed(1)}NM`
          : t.status === 'hit'
            ? 'FISH · HIT'
            : t.status === 'expired'
              ? 'FISH · END'
              : `FISH · ${t.status.toUpperCase()}`;
      return {
        id: t.id,
        kind: 'torpedo' as const,
        color,
        status: t.status,
        points: pathPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        origin,
        tip,
        tipX: tip.x + Math.cos(hRad) * tipLen,
        tipY: tip.y + Math.sin(hRad) * tipLen,
        showHeadingPip: tipLen > 0,
        label: statusLabel,
        onPlot:
          pathPts.some((p) => p.u >= -0.1 && p.u <= 1.1 && p.v >= -0.1 && p.v <= 1.1) ||
          (tip.u >= -0.1 && tip.u <= 1.1 && tip.v >= -0.1 && tip.v <= 1.1),
      };
    });

    const charges = depthCharges.map((c) => {
      const color = unitAccentById.get(c.firerUnitId) ?? '#7ec8ff';
      const launch = c.launchPosition ?? c.path?.[0] ?? c.position;
      const origin = toXy(launch.lat, launch.lon);
      const tip = toXy(c.position.lat, c.position.lon);
      const detonated = c.status === 'detonated' || c.status === 'spent';
      const sinking = c.status === 'sinking';
      const label = detonated
        ? `DC · DET ${Math.round(c.detonatedAtDepthM ?? c.depthSettingM)}M`
        : sinking
          ? `DC · ${Math.round(c.position.depth)}→${Math.round(c.depthSettingM)}M`
          : `DC · ${c.status.toUpperCase()}`;
      return {
        id: c.id,
        kind: 'depth_charge' as const,
        color,
        status: c.status,
        firerUnitId: c.firerUnitId,
        launchedTurn: c.launchedTurn,
        origin,
        tip,
        detonated,
        sinking,
        label,
        onPlot:
          (origin.u >= -0.1 && origin.u <= 1.1 && origin.v >= -0.1 && origin.v <= 1.1) ||
          (tip.u >= -0.1 && tip.u <= 1.1 && tip.v >= -0.1 && tip.v <= 1.1),
      };
    });

    // Polyline through a pattern's drop points (along-track trail).
    const trailKey = (c: (typeof charges)[number]) => `${c.firerUnitId}|${c.launchedTurn}`;
    const trailGroups = new Map<string, typeof charges>();
    for (const c of charges) {
      const k = trailKey(c);
      const list = trailGroups.get(k) ?? [];
      list.push(c);
      trailGroups.set(k, list);
    }
    const dropTrails = [...trailGroups.values()]
      .filter((g) => g.length >= 2)
      .map((g) => {
        const sorted = [...g].sort((a, b) => a.id.localeCompare(b.id));
        return {
          id: `dctrail-${sorted[0]!.id}`,
          color: sorted[0]!.color,
          points: sorted.map((c) => `${c.origin.x.toFixed(1)},${c.origin.y.toFixed(1)}`).join(' '),
          onPlot: sorted.some((c) => c.onPlot),
        };
      });

    return { fish, charges, dropTrails };
  }, [torpedoes, depthCharges, view, unitAccentById]);

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
        const showOrdered = courseDelta > 0.5;
        /**
         * Keep unit name/stats clear of the icon (r=8) + CRT label halo and the
         * heading/course pip: prefer the side opposite the steer tip; when the tip
         * is nearly N/S, fall back to the prior trail-inbound flip.
         */
        const steerRad = showOrdered ? oRad : hRad;
        const pipDx = Math.cos(steerRad);
        const inboundDx = trailInboundDx.get(unit.id);
        let flipLeft = false;
        if (Math.abs(pipDx) >= 0.3) {
          flipLeft = pipDx > 0;
        } else if (inboundDx != null && inboundDx < -0.5) {
          flipLeft = true;
        }
        /** Outer ring 8 + halo ~4 + gap; clears tip when labels sit beside. */
        const labelClear = 22;
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
          showOrdered,
          labelDx: flipLeft ? -labelClear : labelClear,
          labelAnchor: flipLeft ? ('end' as const) : ('start' as const),
          /** Side block — not parked on the icon crown so the pip stays readable. */
          labelNameDy: -4,
          labelIdentityDy: 10,
          labelStatsDy: 22,
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
    [units, view, zoom, trailInboundDx],
  );

  /**
   * Sensor detection radii — rings under trails; one stacked label block per unit
   * so radar + hydrophone readouts do not share the same glyph box.
   */
  const { rangeRings, rangeLabelGroups } = useMemo(() => {
    if (!showSensorRanges) return { rangeRings: [], rangeLabelGroups: [] };
    const rings: {
      key: string;
      x: number;
      y: number;
      rx: number;
      ry: number;
      color: string;
      fillOpacity: number;
    }[] = [];
    const labelGroups: {
      key: string;
      x: number;
      y: number;
      color: string;
      lines: string[];
    }[] = [];
    const kindOrder: Record<string, number> = {
      radar: 0,
      hydrophone: 1,
      active_sonar: 2,
      lookout: 3,
    };
    for (const unit of units) {
      const ranges = sensorRangesForUnit(unit);
      if (!ranges.length) continue;
      const { u, v } = projectToUv(unit.position.lat, unit.position.lon, view);
      // Skip sensors whose host is far off-plot (ring may still clip in).
      if (u < -0.6 || u > 1.6 || v < -0.6 || v > 1.6) continue;
      const x = u * W;
      const y = v * H;
      const color = unitAccent(unit);
      let maxRy = 0;
      let anyRing = false;
      let anyOversized = false;
      let anyEdgeOnPlot = false;
      const lines: { kind: string; text: string; order: number }[] = [];
      for (const r of ranges) {
        const { rx, ry } = rangeBandRadiiPx(unit.position.lat, r.rangeNm, view);
        // Cull rings that cannot intersect the plot (cheap).
        if (x + rx < -8 || x - rx > W + 8 || y + ry < -8 || y - ry > H + 8) continue;
        anyRing = true;
        maxRy = Math.max(maxRy, ry);
        const edgeOnPlot =
          x - rx > 8 && x + rx < W - 8 && y - ry > 8 && y + ry < H - 8;
        if (edgeOnPlot) anyEdgeOnPlot = true;
        const oversized = rx > W * 0.55 || ry > H * 0.55;
        if (oversized) anyOversized = true;
        rings.push({
          key: `${unit.id}-${r.kind}-${r.rangeNm}`,
          x,
          y,
          rx,
          ry,
          color,
          fillOpacity: oversized ? 0.1 : 0.05,
        });
        lines.push({
          kind: r.kind,
          text: `${r.kind.toUpperCase()} ${r.rangeNm} NM`,
          order: kindOrder[r.kind] ?? 9,
        });
      }
      if (!anyRing || !lines.length) continue;
      lines.sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind));
      const lineH = 11;
      const stackH = lines.length * lineH;
      // Prefer outer-ring south when the largest ring fits; else stack below the
      // unit name/identity/speed block (clears ~y+22) so kinds stay readable.
      const rawY =
        anyEdgeOnPlot && !anyOversized ? y + maxRy + 12 : y + 48;
      const yClamped = clamp(rawY, 14, H - 4 - stackH);
      labelGroups.push({
        key: `${unit.id}-sensor-labels`,
        x: clamp(x, 48, W - 48),
        y: yClamped,
        color,
        lines: lines.map((l) => l.text),
      });
    }
    return { rangeRings: rings, rangeLabelGroups: labelGroups };
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
          onClick={(e) => {
            e.stopPropagation();
            toggleSensorRanges();
          }}
          onPointerDown={(e) => e.stopPropagation()}
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
          <defs>
            <clipPath id="gt-plot-clip">
              <rect x={0} y={0} width={W} height={H} />
            </clipPath>
          </defs>

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
            GROUND TRUTH · LAT/LON · {GRID_STEP_DEG}° GRID · TRAILS · WEAPONS · TRUE N
            {showSensorRanges ? ' · RANGES' : ''}
          </text>

          {/* Sensor rings only — under trails; labels painted after trails */}
          <g clipPath="url(#gt-plot-clip)" pointerEvents="none">
            {rangeRings.map((b) => (
              <ellipse
                key={b.key}
                cx={b.x}
                cy={b.y}
                rx={b.rx}
                ry={b.ry}
                fill={b.color}
                fillOpacity={b.fillOpacity}
                stroke={b.color}
                strokeWidth={1.5}
                strokeOpacity={0.65}
                strokeDasharray="6 4"
              />
            ))}
          </g>

          {/* Trails under labels/units — simple polylines (CRT-friendly, cheap) */}
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

          {/* Weapon tracks — launch origin → path → tip/detonation (umpire full truth) */}
          <g className="map-weapon-tracks" pointerEvents="none">
            {weaponOverlays.fish
              .filter((f) => f.onPlot)
              .map((f) => (
                <g key={`fish-${f.id}`} opacity={f.status === 'running' ? 1 : 0.75}>
                  {f.points.includes(' ') || f.points.split(',').length > 2 ? (
                    <polyline
                      points={f.points}
                      fill="none"
                      stroke="#ffc857"
                      strokeWidth={1.5}
                      strokeOpacity={0.85}
                      strokeDasharray="5 3"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ) : null}
                  {/* Launch origin */}
                  <circle
                    cx={f.origin.x}
                    cy={f.origin.y}
                    r={3.5}
                    fill="none"
                    stroke="#ffc857"
                    strokeWidth={1.25}
                  />
                  <circle cx={f.origin.x} cy={f.origin.y} r={1.5} fill="#ffc857" />
                  {/* Tip + heading pip (pip only while running — hit ends at tip) */}
                  {f.showHeadingPip && (
                    <line
                      x1={f.tip.x}
                      y1={f.tip.y}
                      x2={f.tipX}
                      y2={f.tipY}
                      stroke="#ffc857"
                      strokeWidth={1.5}
                      strokeLinecap="square"
                    />
                  )}
                  <circle
                    cx={f.tip.x}
                    cy={f.tip.y}
                    r={f.status === 'hit' ? 5 : 3.5}
                    fill={f.status === 'hit' ? '#ff6a4a' : '#ffc857'}
                    stroke="#061a0e"
                    strokeWidth={1}
                  />
                  <text
                    className="map-plot-label"
                    x={f.tip.x + 8}
                    y={f.tip.y - 6}
                    fill="#ffc857"
                    fontSize={8}
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {f.label}
                  </text>
                </g>
              ))}

            {weaponOverlays.dropTrails
              .filter((t) => t.onPlot)
              .map((t) => (
                <polyline
                  key={t.id}
                  points={t.points}
                  fill="none"
                  stroke="#7ec8ff"
                  strokeWidth={1.25}
                  strokeOpacity={0.55}
                  strokeDasharray="4 3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}

            {weaponOverlays.charges
              .filter((c) => c.onPlot)
              .map((c) => (
                <g key={`dc-${c.id}`} opacity={c.sinking ? 1 : 0.8}>
                  {/* Drop origin → current (same lat/lon while sinking; still mark both) */}
                  <line
                    x1={c.origin.x}
                    y1={c.origin.y}
                    x2={c.tip.x}
                    y2={c.tip.y}
                    stroke="#7ec8ff"
                    strokeWidth={1}
                    strokeOpacity={0.5}
                    strokeDasharray="2 3"
                  />
                  <rect
                    x={c.origin.x - 3}
                    y={c.origin.y - 3}
                    width={6}
                    height={6}
                    fill="none"
                    stroke="#7ec8ff"
                    strokeWidth={1.25}
                    transform={`rotate(45 ${c.origin.x} ${c.origin.y})`}
                  />
                  {c.detonated ? (
                    <>
                      <circle
                        cx={c.tip.x}
                        cy={c.tip.y}
                        r={9}
                        fill="#7ec8ff"
                        fillOpacity={0.12}
                        stroke="#7ec8ff"
                        strokeWidth={1.25}
                        strokeDasharray="3 2"
                      />
                      <circle cx={c.tip.x} cy={c.tip.y} r={3} fill="#c8f0ff" />
                    </>
                  ) : (
                    <circle
                      cx={c.tip.x}
                      cy={c.tip.y}
                      r={3.5}
                      fill="#7ec8ff"
                      stroke="#061a0e"
                      strokeWidth={1}
                    />
                  )}
                  <text
                    className="map-plot-label"
                    x={c.tip.x + 8}
                    y={c.tip.y + (c.detonated ? 14 : 4)}
                    fill="#7ec8ff"
                    fontSize={8}
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {c.label}
                  </text>
                </g>
              ))}
          </g>

          {/* Combined per-unit sensor readout — above trails so rings stay labeled */}
          <g className="map-sensor-labels" pointerEvents="none">
            {rangeLabelGroups.map((g) => (
              <g key={g.key}>
                {g.lines.map((line, i) => (
                  <text
                    key={`${g.key}-${i}`}
                    className="map-plot-label"
                    x={g.x}
                    y={g.y + i * 11}
                    textAnchor="middle"
                    fill={g.color}
                    fillOpacity={0.92}
                    fontSize={9}
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {line}
                  </text>
                ))}
              </g>
            ))}
          </g>

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
                  className="map-plot-label"
                  x={m.x + m.labelDx}
                  y={m.y + m.labelNameDy}
                  textAnchor={m.labelAnchor}
                  fill="#7dff9a"
                  fontSize={11}
                  fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
                >
                  {m.name}
                </text>
                <text
                  className="map-plot-label"
                  x={m.x + m.labelDx}
                  y={m.y + m.labelIdentityDy}
                  textAnchor={m.labelAnchor}
                  fill="#5a9a68"
                  fontSize={9}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {m.identity}
                </text>
                <text
                  className="map-plot-label"
                  x={m.x + m.labelDx}
                  y={m.y + m.labelStatsDy}
                  textAnchor={m.labelAnchor}
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
  if (
    weaponsSignature(prev.torpedoes, prev.depthCharges) !==
    weaponsSignature(next.torpedoes, next.depthCharges)
  ) {
    return false;
  }
  return unitsSignature(prev.units) === unitsSignature(next.units);
});
