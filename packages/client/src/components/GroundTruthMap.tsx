import type { BoundingBox, UnitState } from '@war-patrol/shared';
import { projectToUv } from '@war-patrol/shared';

interface Props {
  area: BoundingBox;
  units: UnitState[];
}

const SIDE_COLORS: Record<string, string> = {
  blue: '#6db3ff',
  red: '#ff8a7a',
  neutral: '#c9c3a8',
};

export function GroundTruthMap({ area, units }: Props) {
  const w = 640;
  const h = 420;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      role="img"
      aria-label="Ground truth operating area map"
      style={{
        background: 'linear-gradient(180deg, #124052 0%, #0d2c38 100%)',
        border: '1px solid var(--line)',
        borderRadius: 2,
        display: 'block',
      }}
    >
      {/* Grid */}
      {Array.from({ length: 8 }).map((_, i) => {
        const x = ((i + 1) / 9) * w;
        const y = ((i + 1) / 9) * h;
        return (
          <g key={i} stroke="var(--map-grid)" strokeWidth={1}>
            <line x1={x} y1={0} x2={x} y2={h} />
            <line x1={0} y1={y} x2={w} y2={y} />
          </g>
        );
      })}

      {units.map((unit) => {
        const { u, v } = projectToUv(unit.position.lat, unit.position.lon, area);
        const x = u * w;
        const y = v * h;
        const color = SIDE_COLORS[unit.side] ?? '#e7f0f3';
        const rad = ((unit.heading - 90) * Math.PI) / 180;
        const tipX = x + Math.cos(rad) * 16;
        const tipY = y + Math.sin(rad) * 16;
        return (
          <g key={unit.id} className="fade-in">
            <circle cx={x} cy={y} r={7} fill={color} opacity={0.9} />
            <line
              x1={x}
              y1={y}
              x2={tipX}
              y2={tipY}
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            <text
              x={x + 10}
              y={y - 10}
              fill="#e7f0f3"
              fontSize={11}
              fontFamily="IBM Plex Mono, monospace"
            >
              {unit.name}
            </text>
            <text
              x={x + 10}
              y={y + 4}
              fill="#9bb3bd"
              fontSize={10}
              fontFamily="IBM Plex Mono, monospace"
            >
              {unit.speed.toFixed(0)} kn · {unit.heading.toFixed(0)}°
              {unit.position.depth > 0 ? ` · ${unit.position.depth.toFixed(0)} m` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
