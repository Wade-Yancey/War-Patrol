import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVE_SONAR_PING_INTERVAL_SEC,
  formatActiveSonarEstimatedDepth,
  type RadarContact,
} from '@war-patrol/shared';
import {
  loadSonarPingBuffer,
  playSonarPingSample,
  SONAR_PING_OWN_GAIN,
} from '../audio/sonarPing';

interface Props {
  contacts: RadarContact[];
  maxRangeNm: number;
  halfAngleDeg: number;
  ownHeading: number;
  /** When true, emit active-search ping sample locally. */
  pinging: boolean;
}

/** Operator-selectable display scales (nm) for the forward-cone scope. */
export const SONAR_RANGE_PRESETS_NM = [2, 4, 8, 12] as const;
export type SonarRangePresetNm = (typeof SONAR_RANGE_PRESETS_NM)[number];

const SIZE = 900;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SCOPE_R = 390;

interface PersistedBlip extends RadarContact {
  bornAt: number;
  lastSeenAt: number;
}

function contactsKey(contacts: RadarContact[]): string {
  return contacts
    .map(
      (c) =>
        `${c.id}:${c.bearing.toFixed(1)}:${c.rangeNm.toFixed(2)}:${c.strength}:${c.signature}:${c.estimatedDepthM ?? ''}`,
    )
    .join('|');
}

function defaultScaleNm(sensorMaxNm: number): SonarRangePresetNm {
  const max = sensorMaxNm > 0 ? sensorMaxNm : 8;
  const fit = [...SONAR_RANGE_PRESETS_NM].reverse().find((p) => p <= max);
  return fit ?? 8;
}

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * r, y: CY + Math.sin(rad) * r };
}

/**
 * Forward-cone active search sonar scope — not an omnidirectional PPI.
 * Blips + anonymous contact list only while the set is toggled ON.
 */
function ActiveSonarScopeInner({
  contacts,
  maxRangeNm,
  halfAngleDeg,
  ownHeading,
  pinging,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [scaleNm, setScaleNm] = useState<SonarRangePresetNm>(() => defaultScaleNm(maxRangeNm));
  const persistRef = useRef<Map<string, PersistedBlip>>(new Map());
  const key = contactsKey(contacts);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const pingBufferRef = useRef<AudioBuffer | null>(null);
  const pingTimerRef = useRef<number | null>(null);

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

  // Active-search ping sample while sonar is ON (same WAV hydrophones hear).
  useEffect(() => {
    if (!pinging) {
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      return;
    }

    const playPing = async () => {
      try {
        if (!audioCtxRef.current) {
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          audioCtxRef.current = new Ctx();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') await ctx.resume();
        if (!pingBufferRef.current) {
          pingBufferRef.current = await loadSonarPingBuffer(ctx);
        }
        playSonarPingSample(ctx, pingBufferRef.current, ctx.destination, SONAR_PING_OWN_GAIN);
      } catch {
        /* autoplay / audio restrictions — ignore */
      }
    };

    void playPing();
    pingTimerRef.current = window.setInterval(
      () => void playPing(),
      ACTIVE_SONAR_PING_INTERVAL_SEC * 1000,
    );
    return () => {
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    };
  }, [pinging]);

  useEffect(() => {
    return () => {
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      pingBufferRef.current = null;
    };
  }, []);

  const rings = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps }, (_, i) => {
      const frac = (i + 1) / steps;
      const nm = scaleNm * frac;
      return {
        r: SCOPE_R * frac,
        label: Number.isInteger(nm) ? `${nm}` : nm.toFixed(1),
      };
    });
  }, [scaleNm]);

  const hdg = ((ownHeading % 360) + 360) % 360;
  const leftBearing = ((hdg - halfAngleDeg) % 360 + 360) % 360;
  const rightBearing = ((hdg + halfAngleDeg) % 360 + 360) % 360;
  const leftEdge = polar(leftBearing, SCOPE_R);
  const rightEdge = polar(rightBearing, SCOPE_R);
  const tip = polar(hdg, SCOPE_R);

  // Large arc flag when cone spans > 180° (should not for ±30 stub).
  const largeArc = halfAngleDeg > 90 ? 1 : 0;
  const conePath = `M ${CX} ${CY} L ${leftEdge.x} ${leftEdge.y} A ${SCOPE_R} ${SCOPE_R} 0 ${largeArc} 1 ${rightEdge.x} ${rightEdge.y} Z`;

  const visibleContacts = useMemo(
    () => contacts.filter((c) => c.rangeNm <= scaleNm),
    [contacts, scaleNm],
  );

  const contactIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of contacts) {
      map.set(c.id, c.labelN);
    }
    return map;
  }, [contacts]);

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
      const labelN = contactIndexById.get(b.id) ?? b.labelN;
      const live = contactIndexById.has(b.id) && b.rangeNm <= scaleNm;
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
    <div className="radar-scope radar-console">
      <div className="radar-scope-plot">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="radar-scope-svg"
          role="img"
          aria-label={`Active search sonar forward cone ±${halfAngleDeg}°, ${scaleNm} nautical mile scale`}
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <radialGradient id="sonar-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#0a2a14" />
              <stop offset="70%" stopColor="#041208" />
              <stop offset="100%" stopColor="#010805" />
            </radialGradient>
            <clipPath id="sonar-cone-clip">
              <path d={conePath} />
            </clipPath>
          </defs>

          <circle cx={CX} cy={CY} r={SCOPE_R + 36} fill="#0a120c" stroke="#2a3830" strokeWidth={10} />
          <circle cx={CX} cy={CY} r={SCOPE_R} fill="url(#sonar-glow)" stroke="#1a8f3c" strokeWidth={2} />

          {/* Dim full disc; bright cone = search sector */}
          <circle cx={CX} cy={CY} r={SCOPE_R} fill="rgba(0,0,0,0.35)" />
          <path d={conePath} fill="rgba(61,255,106,0.08)" stroke="#3dff6a" strokeWidth={2} />

          <g clipPath="url(#sonar-cone-clip)">
            {rings.map((ring) => (
              <g key={ring.r}>
                <circle
                  cx={CX}
                  cy={CY}
                  r={ring.r}
                  fill="none"
                  stroke="rgba(61,255,106,0.28)"
                  strokeWidth={1}
                />
              </g>
            ))}
          </g>

          {/* Cone edge ticks */}
          <line
            x1={CX}
            y1={CY}
            x2={leftEdge.x}
            y2={leftEdge.y}
            stroke="#7dff9a"
            strokeWidth={1.5}
            strokeDasharray="6 8"
            opacity={0.7}
          />
          <line
            x1={CX}
            y1={CY}
            x2={rightEdge.x}
            y2={rightEdge.y}
            stroke="#7dff9a"
            strokeWidth={1.5}
            strokeDasharray="6 8"
            opacity={0.7}
          />
          <line
            x1={CX}
            y1={CY}
            x2={tip.x}
            y2={tip.y}
            stroke="#3dff6a"
            strokeWidth={2}
            opacity={0.85}
          />

          <text
            x={tip.x}
            y={tip.y}
            fill="#7dff9a"
            fontSize={18}
            fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {String(Math.round(hdg)).padStart(3, '0')}
          </text>

          <circle cx={CX} cy={CY} r={5} fill="#3dff6a" />

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
            CONE ±{halfAngleDeg}° · {scaleNm} NM
          </p>
          <div className="radar-scale-buttons" role="group" aria-label="Sonar range scale">
            {SONAR_RANGE_PRESETS_NM.map((preset) => (
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
              Sensor max {maxRangeNm} nm.
            </p>
          )}
          {pinging && (
            <p className="mono readout" style={{ margin: '0.5rem 0 0', color: 'var(--accent-strong)' }}>
              PING · ACTIVE
            </p>
          )}
        </div>

        <div className="radar-contact-list">
          <h3>Contacts</h3>
          {visibleContacts.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No echoes in cone.
            </p>
          ) : (
            <ul className="sensor-contact-scroll">
              {visibleContacts.map((c) => (
                <li key={c.id} className="mono">
                  <span className="readout">Contact {c.labelN}</span>
                  <div className="radar-contact-meta">
                    <span>{String(Math.round(c.bearing)).padStart(3, '0')}°</span>
                    <span>{c.rangeNm.toFixed(1)} nm</span>
                    <span>{c.signature}</span>
                    {c.estimatedDepthM != null && (
                      <span title="Coarse sonar depth estimate — not exact keel depth">
                        {formatActiveSonarEstimatedDepth(c.estimatedDepthM)}
                      </span>
                    )}
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

export const ActiveSonarScope = memo(ActiveSonarScopeInner, (prev, next) => {
  return (
    prev.maxRangeNm === next.maxRangeNm &&
    prev.halfAngleDeg === next.halfAngleDeg &&
    prev.ownHeading === next.ownHeading &&
    prev.pinging === next.pinging &&
    contactsKey(prev.contacts) === contactsKey(next.contacts)
  );
});
