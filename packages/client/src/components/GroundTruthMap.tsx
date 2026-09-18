import { memo, useMemo } from 'react';
import type { BoundingBox, UnitState } from '@war-patrol/shared';
import { projectToUv } from '@war-patrol/shared';

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

const GRID = Array.from({ length: 8 }, (_, i) => {
  const x = ((i + 1) / 9) * W;
  const y = ((i + 1) / 9) * H;
  return { i, x, y };
});

function unitsSignature(units: UnitState[]): string {
  return units
    .map(
      (u) =>
        `${u.id}:${u.position.lat.toFixed(5)},${u.position.lon.toFixed(5)},${u.heading.toFixed(1)},${u.speed.toFixed(1)},${u.position.depth.toFixed(0)}`,
    )
    .join('|');
}

function GroundTruthMapInner({ area, units }: Props) {
  const markers = useMemo(
    () =>
      units.map((unit) => {
        const { u, v } = projectToUv(unit.position.lat, unit.position.lon, area);
        const x = u * W;
        const y = v * H;
        const color = SIDE_COLORS[unit.side] ?? '#c8ffd4';
        const rad = ((unit.heading - 90) * Math.PI) / 180;
        return {
          id: unit.id,
          name: unit.name.toUpperCase(),
          x,
          y,
          color,
          tipX: x + Math.cos(rad) * 18,
          tipY: y + Math.sin(rad) * 18,
          label: `${unit.speed.toFixed(0)} KN · ${unit.heading.toFixed(0)}°${
            unit.position.depth > 0 ? ` · ${unit.position.depth.toFixed(0)} M` : ''
          }`,
        };
      }),
    [area, units],
  );

  return (
    <div className="map-frame">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Ground truth operating area map"
      >
        <rect width={W} height={H} fill="#061a0e" />

        {GRID.map(({ i, x, y }) => (
          <g key={i} stroke="#1a4a28" strokeWidth={1}>
            <line x1={x} y1={0} x2={x} y2={H} />
            <line x1={0} y1={y} x2={W} y2={y} />
          </g>
        ))}

        <g stroke="#3dff6a" strokeWidth={1.5} opacity={0.45}>
          <path d="M8 8 H28 M8 8 V28" fill="none" />
          <path d={`M${W - 8} 8 H${W - 28} M${W - 8} 8 V28`} fill="none" />
          <path d={`M8 ${H - 8} H28 M8 ${H - 8} V${H - 28}`} fill="none" />
          <path d={`M${W - 8} ${H - 8} H${W - 28} M${W - 8} ${H - 8} V${H - 28}`} fill="none" />
        </g>

        <text x={12} y={H - 14} fill="#5a9a68" fontSize={10} fontFamily="IBM Plex Mono, monospace">
          GROUND TRUTH · CRT PLOT
        </text>

        {markers.map((m) => (
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
  );
}

export const GroundTruthMap = memo(GroundTruthMapInner, (prev, next) => {
  if (prev.area !== next.area) {
    if (
      prev.area.minLat !== next.area.minLat ||
      prev.area.maxLat !== next.area.maxLat ||
      prev.area.minLon !== next.area.minLon ||
      prev.area.maxLon !== next.area.maxLon
    ) {
      return false;
    }
  }
  return unitsSignature(prev.units) === unitsSignature(next.units);
});
