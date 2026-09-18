import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { RadarContact } from '@war-patrol/shared';

interface Props {
  contacts: RadarContact[];
  maxRangeNm: number;
  /** Own-ship heading (degrees true) — drawn as a short lubber line. */
  ownHeading: number;
}

const SIZE = 520;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SCOPE_R = 220;
const SWEEP_MS = 4200;

interface PersistedBlip extends RadarContact {
  bornAt: number;
  lastSeenAt: number;
}

function contactsKey(contacts: RadarContact[]): string {
  return contacts.map((c) => `${c.id}:${c.bearing.toFixed(1)}:${c.rangeNm.toFixed(2)}`).join('|');
}

/**
 * Traditional round PPI radar scope — own ship center, true bearings on the rim.
 * Sweep + short blip persistence; kept to SVG/CSS for tablet snappiness (ARCH-DET spirit).
 */
function RadarScopeInner({ contacts, maxRangeNm, ownHeading }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const persistRef = useRef<Map<string, PersistedBlip>>(new Map());
  const key = contactsKey(contacts);

  useEffect(() => {
    const map = persistRef.current;
    const seen = new Set<string>();
    const t = Date.now();
    for (const c of contacts) {
      seen.add(c.id);
      const prev = map.get(c.id);
      if (prev) {
        map.set(c.id, { ...c, bornAt: prev.bornAt, lastSeenAt: t });
      } else {
        map.set(c.id, { ...c, bornAt: t, lastSeenAt: t });
      }
    }
    for (const id of [...map.keys()]) {
      if (!seen.has(id) && t - (map.get(id)?.lastSeenAt ?? 0) > 8000) {
        map.delete(id);
      }
    }
  }, [key, contacts]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const rings = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps }, (_, i) => {
      const frac = (i + 1) / steps;
      return { r: SCOPE_R * frac, label: `${(maxRangeNm * frac).toFixed(0)}` };
    });
  }, [maxRangeNm]);

  const bearings = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const deg = i * 30;
        const rad = ((deg - 90) * Math.PI) / 180;
        return {
          deg,
          x1: CX + Math.cos(rad) * (SCOPE_R - 10),
          y1: CY + Math.sin(rad) * (SCOPE_R - 10),
          x2: CX + Math.cos(rad) * SCOPE_R,
          y2: CY + Math.sin(rad) * SCOPE_R,
          tx: CX + Math.cos(rad) * (SCOPE_R + 18),
          ty: CY + Math.sin(rad) * (SCOPE_R + 18),
        };
      }),
    [],
  );

  const headingRad = ((ownHeading - 90) * Math.PI) / 180;
  const blips = [...persistRef.current.values()].map((b) => {
    const age = now - b.lastSeenAt;
    const fade = Math.max(0, 1 - age / 7000);
    const frac = Math.min(1, b.rangeNm / Math.max(maxRangeNm, 0.001));
    const rad = ((b.bearing - 90) * Math.PI) / 180;
    const r = frac * SCOPE_R;
    return {
      ...b,
      x: CX + Math.cos(rad) * r,
      y: CY + Math.sin(rad) * r,
      opacity: 0.25 + 0.75 * fade * (0.4 + 0.6 * b.strength),
      r: 3 + 3 * b.strength,
    };
  });

  return (
    <div className="radar-scope" role="img" aria-label="Radar plan position indicator">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" className="radar-scope-svg">
        <defs>
          <radialGradient id="radar-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0a2a14" />
            <stop offset="70%" stopColor="#041208" />
            <stop offset="100%" stopColor="#010805" />
          </radialGradient>
        </defs>

        <circle cx={CX} cy={CY} r={SCOPE_R + 28} fill="#0a120c" stroke="#2a3830" strokeWidth={8} />
        <circle cx={CX} cy={CY} r={SCOPE_R} fill="url(#radar-glow)" stroke="#1a8f3c" strokeWidth={1.5} />

        {rings.map((ring) => (
          <g key={ring.r}>
            <circle
              cx={CX}
              cy={CY}
              r={ring.r}
              fill="none"
              stroke="rgba(61,255,106,0.22)"
              strokeWidth={1}
            />
            <text
              x={CX + 6}
              y={CY - ring.r + 12}
              fill="#5a9a68"
              fontSize={10}
              fontFamily="IBM Plex Mono, monospace"
            >
              {ring.label}
            </text>
          </g>
        ))}

        {bearings.map((b) => (
          <g key={b.deg}>
            <line x1={b.x1} y1={b.y1} x2={b.x2} y2={b.y2} stroke="#3dff6a" strokeWidth={1.5} />
            <text
              x={b.tx}
              y={b.ty}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#7dff9a"
              fontSize={12}
              fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
            >
              {String(b.deg).padStart(3, '0')}
            </text>
          </g>
        ))}

        {/* Cardinal hairlines */}
        <line x1={CX} y1={CY - SCOPE_R} x2={CX} y2={CY + SCOPE_R} stroke="rgba(61,255,106,0.18)" />
        <line x1={CX - SCOPE_R} y1={CY} x2={CX + SCOPE_R} y2={CY} stroke="rgba(61,255,106,0.18)" />

        {/* Own-ship heading tick */}
        <line
          x1={CX}
          y1={CY}
          x2={CX + Math.cos(headingRad) * 28}
          y2={CY + Math.sin(headingRad) * 28}
          stroke="#7dff9a"
          strokeWidth={2}
        />
        <circle cx={CX} cy={CY} r={4} fill="#3dff6a" />

        {/* Sweep wedge (CSS-rotated group) */}
        <g className="radar-sweep" style={{ transformOrigin: `${CX}px ${CY}px`, animationDuration: `${SWEEP_MS}ms` }}>
          <path
            d={`M ${CX} ${CY} L ${CX} ${CY - SCOPE_R} A ${SCOPE_R} ${SCOPE_R} 0 0 1 ${CX + SCOPE_R * 0.35} ${CY - SCOPE_R * 0.94} Z`}
            fill="rgba(61,255,106,0.14)"
          />
          <line
            x1={CX}
            y1={CY}
            x2={CX}
            y2={CY - SCOPE_R}
            stroke="#3dff6a"
            strokeWidth={2}
            opacity={0.85}
          />
        </g>

        {blips.map((b) => (
          <g key={b.id} opacity={b.opacity}>
            <circle cx={b.x} cy={b.y} r={b.r} fill="#3dff6a" />
            <circle cx={b.x} cy={b.y} r={b.r + 3} fill="none" stroke="#7dff9a" strokeWidth={0.8} opacity={0.5} />
          </g>
        ))}

        <text
          x={CX}
          y={SIZE - 14}
          textAnchor="middle"
          fill="#5a9a68"
          fontSize={11}
          fontFamily="IBM Plex Mono, monospace"
        >
          PPI · TRUE · {maxRangeNm.toFixed(0)} NM
        </text>
      </svg>

      <div className="radar-contact-list">
        <h3>Contacts</h3>
        {contacts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No echoes in range.
          </p>
        ) : (
          <ul>
            {contacts.map((c) => (
              <li key={c.id} className="mono">
                <span className="readout">{String(Math.round(c.bearing)).padStart(3, '0')}°</span>
                <span>{c.rangeNm.toFixed(1)} nm</span>
                <span className="muted">{c.id}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export const RadarScope = memo(RadarScopeInner, (prev, next) => {
  return (
    prev.maxRangeNm === next.maxRangeNm &&
    prev.ownHeading === next.ownHeading &&
    contactsKey(prev.contacts) === contactsKey(next.contacts)
  );
});
