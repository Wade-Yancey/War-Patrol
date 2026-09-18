import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { RadarContact } from '@war-patrol/shared';

interface Props {
  contacts: RadarContact[];
  /** Server sensor max range (nm) — used to pick a sensible default scale. */
  maxRangeNm: number;
  /** Own-ship heading (degrees true) — drawn as a short lubber line. */
  ownHeading: number;
}

/** Operator-selectable PPI display scales (nm). Server still sends true ranges. */
export const RADAR_RANGE_PRESETS_NM = [5, 10, 25, 50] as const;
export type RadarRangePresetNm = (typeof RADAR_RANGE_PRESETS_NM)[number];

/** Large square canvas; CSS scales to dominate the viewport. */
const SIZE = 900;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SCOPE_R = 390;
const SWEEP_MS = 4200;

interface PersistedBlip extends RadarContact {
  bornAt: number;
  lastSeenAt: number;
}

function contactsKey(contacts: RadarContact[]): string {
  return contacts
    .map(
      (c) =>
        `${c.id}:${c.bearing.toFixed(1)}:${c.rangeNm.toFixed(2)}:${c.strength}:${c.signature}`,
    )
    .join('|');
}

function defaultScaleNm(sensorMaxNm: number): RadarRangePresetNm {
  const max = sensorMaxNm > 0 ? sensorMaxNm : 25;
  // Prefer largest preset that does not exceed the installed sensor, else 25.
  const fit = [...RADAR_RANGE_PRESETS_NM].reverse().find((p) => p <= max);
  return fit ?? 25;
}

/**
 * Traditional round PPI radar scope — own ship center, true bearings on the rim.
 * Sweep + short blip persistence; kept to SVG/CSS for tablet snappiness (ARCH-DET spirit).
 */
function RadarScopeInner({ contacts, maxRangeNm, ownHeading }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [scaleNm, setScaleNm] = useState<RadarRangePresetNm>(() => defaultScaleNm(maxRangeNm));
  const persistRef = useRef<Map<string, PersistedBlip>>(new Map());
  const key = contactsKey(contacts);

  useEffect(() => {
    setScaleNm(defaultScaleNm(maxRangeNm));
  }, [maxRangeNm]);

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
    const steps = 5;
    return Array.from({ length: steps }, (_, i) => {
      const frac = (i + 1) / steps;
      const nm = scaleNm * frac;
      return {
        r: SCOPE_R * frac,
        label: Number.isInteger(nm) ? `${nm}` : nm.toFixed(1),
      };
    });
  }, [scaleNm]);

  /** Dense compass: 5° ticks, labels every 10°. */
  const bearings = useMemo(() => {
    const marks: Array<{
      deg: number;
      major: boolean;
      label: boolean;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      tx: number;
      ty: number;
    }> = [];
    for (let deg = 0; deg < 360; deg += 5) {
      const major = deg % 30 === 0;
      const label = deg % 10 === 0;
      const tick = major ? 18 : label ? 12 : 7;
      const rad = ((deg - 90) * Math.PI) / 180;
      marks.push({
        deg,
        major,
        label,
        x1: CX + Math.cos(rad) * (SCOPE_R - tick),
        y1: CY + Math.sin(rad) * (SCOPE_R - tick),
        x2: CX + Math.cos(rad) * SCOPE_R,
        y2: CY + Math.sin(rad) * SCOPE_R,
        tx: CX + Math.cos(rad) * (SCOPE_R + 22),
        ty: CY + Math.sin(rad) * (SCOPE_R + 22),
      });
    }
    return marks;
  }, []);

  const headingRad = ((ownHeading - 90) * Math.PI) / 180;

  /** Contacts inside the selected display scale, same order as the table. */
  const visibleContacts = useMemo(
    () => contacts.filter((c) => c.rangeNm <= scaleNm),
    [contacts, scaleNm],
  );

  const contactIndexById = useMemo(() => {
    const map = new Map<string, number>();
    visibleContacts.forEach((c, i) => map.set(c.id, i + 1));
    return map;
  }, [visibleContacts]);

  const blips = [...persistRef.current.values()]
    .filter((b) => b.rangeNm <= scaleNm || contactIndexById.has(b.id))
    .map((b) => {
      const age = now - b.lastSeenAt;
      const fade = Math.max(0, 1 - age / 7000);
      const frac = Math.min(1, b.rangeNm / Math.max(scaleNm, 0.001));
      const rad = ((b.bearing - 90) * Math.PI) / 180;
      const r = frac * SCOPE_R;
      const x = CX + Math.cos(rad) * r;
      const y = CY + Math.sin(rad) * r;
      const blipR = 4 + 5 * b.strength;
      const labelN = contactIndexById.get(b.id);
      const live = labelN != null && b.rangeNm <= scaleNm;
      const opacity = live ? Math.max(0.92, 0.85 + 0.15 * b.strength) : Math.max(0.25, fade * 0.55);
      const labelOnLeft = x > CX + SCOPE_R * 0.35;
      return {
        ...b,
        x,
        y,
        opacity,
        r: blipR,
        labelN: live ? labelN : undefined,
        labelOpacity: live ? 1 : Math.max(0.35, fade * 0.7),
        labelX: labelOnLeft ? x - blipR - 10 : x + blipR + 10,
        labelAnchor: labelOnLeft ? ('end' as const) : ('start' as const),
      };
    });

  return (
    <div className="radar-scope">
      <div className="radar-scope-plot">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="radar-scope-svg"
          role="img"
          aria-label={`Radar PPI, ${scaleNm} nautical mile scale`}
          preserveAspectRatio="xMidYMid meet"
        >
        <defs>
          <radialGradient id="radar-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0a2a14" />
            <stop offset="70%" stopColor="#041208" />
            <stop offset="100%" stopColor="#010805" />
          </radialGradient>
        </defs>

        <circle cx={CX} cy={CY} r={SCOPE_R + 36} fill="#0a120c" stroke="#2a3830" strokeWidth={10} />
        <circle cx={CX} cy={CY} r={SCOPE_R} fill="url(#radar-glow)" stroke="#1a8f3c" strokeWidth={2} />

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
              x={CX + 8}
              y={CY - ring.r + 14}
              fill="#5a9a68"
              fontSize={14}
              fontFamily="IBM Plex Mono, monospace"
            >
              {ring.label}
            </text>
          </g>
        ))}

        {bearings.map((b) => (
          <g key={b.deg}>
            <line
              x1={b.x1}
              y1={b.y1}
              x2={b.x2}
              y2={b.y2}
              stroke={b.major ? '#3dff6a' : 'rgba(61,255,106,0.45)'}
              strokeWidth={b.major ? 2 : 1}
            />
            {b.label && (
              <text
                x={b.tx}
                y={b.ty}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={b.major ? '#7dff9a' : '#5a9a68'}
                fontSize={b.major ? 16 : 11}
                fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
              >
                {String(b.deg).padStart(3, '0')}
              </text>
            )}
          </g>
        ))}

        <line x1={CX} y1={CY - SCOPE_R} x2={CX} y2={CY + SCOPE_R} stroke="rgba(61,255,106,0.18)" />
        <line x1={CX - SCOPE_R} y1={CY} x2={CX + SCOPE_R} y2={CY} stroke="rgba(61,255,106,0.18)" />

        <line
          x1={CX}
          y1={CY}
          x2={CX + Math.cos(headingRad) * 36}
          y2={CY + Math.sin(headingRad) * 36}
          stroke="#7dff9a"
          strokeWidth={3}
        />
        <circle cx={CX} cy={CY} r={5} fill="#3dff6a" />

        <g
          className="radar-sweep"
          style={{ transformOrigin: `${CX}px ${CY}px`, animationDuration: `${SWEEP_MS}ms` }}
        >
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
            strokeWidth={2.5}
            opacity={0.85}
          />
        </g>

        {blips.map((b) => (
          <g key={b.id}>
            <g opacity={b.opacity}>
              <circle cx={b.x} cy={b.y} r={b.r + 2} fill="none" stroke="#7dff9a" strokeWidth={1.5} />
              <circle cx={b.x} cy={b.y} r={b.r} fill="#b8ffc8" />
              <circle cx={b.x} cy={b.y} r={Math.max(2, b.r * 0.45)} fill="#e8ffe8" />
            </g>
            {b.labelN != null && (
              <text
                x={b.labelX}
                y={b.y + 5}
                textAnchor={b.labelAnchor}
                fill="#c8ffd4"
                stroke="#041208"
                strokeWidth={3}
                paintOrder="stroke"
                opacity={b.labelOpacity}
                fontSize={16}
                fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
              >
                Contact {b.labelN}
              </text>
            )}
          </g>
        ))}
        </svg>
      </div>

      <aside className="radar-side-panel">
        <div className="radar-scale-panel">
          <h3>Range scale</h3>
          <p className="mono readout radar-scale-readout">
            PPI · TRUE · {scaleNm} NM
          </p>
          <div className="radar-scale-buttons" role="group" aria-label="Radar range scale">
            {RADAR_RANGE_PRESETS_NM.map((preset) => (
              <button
                key={preset}
                type="button"
                className={preset === scaleNm ? 'primary' : undefined}
                aria-pressed={preset === scaleNm}
                onClick={() => setScaleNm(preset)}
              >
                {preset} nm
              </button>
            ))}
          </div>
          {maxRangeNm > 0 && scaleNm > maxRangeNm && (
            <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
              Sensor max {maxRangeNm} nm — outer rings empty beyond detection.
            </p>
          )}
        </div>

        <div className="radar-contact-list">
          <h3>Contacts</h3>
          {visibleContacts.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No echoes in range.
            </p>
          ) : (
            <ul>
              {visibleContacts.map((c, i) => (
                <li key={c.id} className="mono">
                  <span className="readout">Contact {i + 1}</span>
                  <div className="radar-contact-meta">
                    <span>{String(Math.round(c.bearing)).padStart(3, '0')}°</span>
                    <span>{c.rangeNm.toFixed(1)} nm</span>
                    <span>{c.signature}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
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
