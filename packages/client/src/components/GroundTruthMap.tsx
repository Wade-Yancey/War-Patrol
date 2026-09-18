import type { BoundingBox, UnitState } from '@war-patrol/shared';
import { projectToUv } from '@war-patrol/shared';

interface Props {
  area: BoundingBox;
  units: UnitState[];
}

/** Side markers stay distinct on the tactical plot; chrome stays green phosphor. */
const SIDE_COLORS: Record<string, string> = {
  blue: '#6ec8ff',
  red: '#ff8a6a',
  neutral: '#b8ffc8',
};

export function GroundTruthMap({ area, units }: Props) {
  const w = 640;
  const h = 420;

  return (
    <div className="map-frame">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        role="img"
        aria-label="Ground truth operating area map"
      >
        <defs>
          <radialGradient id="crt-water" cx="50%" cy="45%" r="70%">
            <stop offset="0%" stopColor="#0a2814" />
            <stop offset="100%" stopColor="#030a06" />
          </radialGradient>
          <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width={w} height={h} fill="url(#crt-water)" />

        {/* Range rings / tactical grid */}
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

        {/* Corner tick marks */}
        <g stroke="var(--phosphor)" strokeWidth={1.5} opacity={0.55}>
          <path d={`M8 8 H28 M8 8 V28`} fill="none" />
          <path d={`M${w - 8} 8 H${w - 28} M${w - 8} 8 V28`} fill="none" />
          <path d={`M8 ${h - 8} H28 M8 ${h - 8} V${h - 28}`} fill="none" />
          <path d={`M${w - 8} ${h - 8} H${w - 28} M${w - 8} ${h - 8} V${h - 28}`} fill="none" />
        </g>

        <text
          x={12}
          y={h - 14}
          fill="var(--ink-muted)"
          fontSize={10}
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="0.12em"
        >
          GROUND TRUTH · CRT PLOT
        </text>

        {units.map((unit) => {
          const { u, v } = projectToUv(unit.position.lat, unit.position.lon, area);
          const x = u * w;
          const y = v * h;
          const color = SIDE_COLORS[unit.side] ?? 'var(--ink)';
          const rad = ((unit.heading - 90) * Math.PI) / 180;
          const tipX = x + Math.cos(rad) * 18;
          const tipY = y + Math.sin(rad) * 18;
          return (
            <g key={unit.id} className="fade-in" filter="url(#soft-glow)">
              <circle cx={x} cy={y} r={8} fill="none" stroke={color} strokeWidth={1.5} opacity={0.85} />
              <circle cx={x} cy={y} r={3} fill={color} />
              <line
                x1={x}
                y1={y}
                x2={tipX}
                y2={tipY}
                stroke={color}
                strokeWidth={2}
                strokeLinecap="square"
              />
              <text
                x={x + 12}
                y={y - 10}
                fill="var(--accent-strong)"
                fontSize={11}
                fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
                letterSpacing="0.06em"
              >
                {unit.name.toUpperCase()}
              </text>
              <text
                x={x + 12}
                y={y + 5}
                fill="var(--ink-muted)"
                fontSize={10}
                fontFamily="IBM Plex Mono, monospace"
              >
                {unit.speed.toFixed(0)} KN · {unit.heading.toFixed(0)}°
                {unit.position.depth > 0 ? ` · ${unit.position.depth.toFixed(0)} M` : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
