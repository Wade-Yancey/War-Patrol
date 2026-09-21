import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  ACTIVE_SONAR_PING_INTERVAL_SEC,
  hydrophoneContactGain,
  hydrophoneContactVoiceOffset,
  hydrophoneListenCue,
  normalizeHeading,
  type HydrophoneContact,
  type HydrophoneRangeBand,
} from '@war-patrol/shared';
import {
  hydrophonePingPeakGain,
  loadSonarPingBuffer,
  playSonarPingSample,
} from '../audio/sonarPing';
import {
  depthChargeStaggerDelaySec,
  hydrophoneDepthChargePeakGain,
  loadDepthChargeBuffer,
  playDepthChargeSample,
} from '../audio/depthCharge';
import { useContinuousAngle } from '../hooks/useContinuousAngle';

const PROP_SAMPLE_URL = '/audio/echo-propeller.wav';
/** Bearing nudge step for ◀ / ▶ train buttons (degrees). */
const BEARING_NUDGE_DEG = 1;
/** Delay before continuous hold-repeat starts (ms). */
const NUDGE_HOLD_DELAY_MS = 400;
/** Tick interval while ◀ / ▶ are held (ms) — ~12.5 °/s at 1° step. */
const NUDGE_HOLD_INTERVAL_MS = 80;

interface Props {
  contacts: HydrophoneContact[];
  maxRangeNm: number;
  /** Own-ship heading — lubber mark only (no contact blips). */
  ownHeading: number;
}

const SIZE = 320;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 118;

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * r, y: CY + Math.sin(rad) * r };
}

function bearingFromPointer(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): number {
  const x = clientX - rect.left - rect.width / 2;
  const y = clientY - rect.top - rect.height / 2;
  const deg = (Math.atan2(x, -y) * 180) / Math.PI;
  return normalizeHeading(deg);
}

function rangeBandLabel(band: HydrophoneRangeBand): string {
  switch (band) {
    case 'near':
      return 'NEAR';
    case 'medium':
      return 'MED';
    case 'far':
      return 'FAR';
    default:
      return '—';
  }
}

type ContactVoice = {
  id: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
};

/**
 * CRT hydrophone bearing dial — audio-first (passive listen ≠ own active sonar PPI).
 * Operator trains a listen needle; Web Audio mixes looping propeller samples
 * with per-contact gain from range × beam alignment. Active-sonar ping contacts
 * play the shared ping WAV attenuated by the same range×beam model. No visual contacts.
 */
function HydrophoneScopeInner({ contacts, maxRangeNm, ownHeading }: Props) {
  const [listenBearing, setListenBearing] = useState(0);
  const [listening, setListening] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const pingBufferRef = useRef<AudioBuffer | null>(null);
  const dcBufferRef = useRef<AudioBuffer | null>(null);
  const playedDcIdsRef = useRef<Set<string>>(new Set());
  const masterGainRef = useRef<GainNode | null>(null);
  const voicesRef = useRef<Map<string, ContactVoice>>(new Map());
  const listenRef = useRef(listenBearing);
  const contactsRef = useRef(contacts);
  const nudgeHoldDelayRef = useRef<number | null>(null);
  const nudgeHoldIntervalRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    listenRef.current = listenBearing;
  }, [listenBearing]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  const hdg = normalizeHeading(ownHeading);
  const listen = normalizeHeading(listenBearing);
  const hdgRotateDeg = useContinuousAngle(hdg);
  const listenRotateDeg = useContinuousAngle(listen);

  const cue = useMemo(
    () => hydrophoneListenCue(contacts, listen),
    [contacts, listen],
  );
  const signalLevel = cue.intensity;
  const rangeBand = cue.rangeBand;
  const approxRangeNm = cue.approxRangeNm;

  const ticks = useMemo(() => {
    const marks: Array<{
      deg: number;
      major: boolean;
      cardinal: string | null;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      tx: number;
      ty: number;
    }> = [];
    const cardinals: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let deg = 0; deg < 360; deg += 10) {
      const major = deg % 30 === 0;
      const tick = major ? 14 : 8;
      const outer = polar(deg, R);
      const inner = polar(deg, R - tick);
      const label = polar(deg, R - 28);
      marks.push({
        deg,
        major,
        cardinal: cardinals[deg] ?? null,
        x1: inner.x,
        y1: inner.y,
        x2: outer.x,
        y2: outer.y,
        tx: label.x,
        ty: label.y,
      });
    }
    return marks;
  }, []);

  const ensureAudio = useCallback(async (): Promise<boolean> => {
    try {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new Ctx();
        const master = audioCtxRef.current.createGain();
        master.gain.value = 0.55;
        master.connect(audioCtxRef.current.destination);
        masterGainRef.current = master;
      }
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      if (!bufferRef.current) {
        const res = await fetch(PROP_SAMPLE_URL);
        if (!res.ok) throw new Error(`Sample fetch ${res.status}`);
        const raw = await res.arrayBuffer();
        bufferRef.current = await audioCtxRef.current.decodeAudioData(raw.slice(0));
      }
      if (!pingBufferRef.current) {
        pingBufferRef.current = await loadSonarPingBuffer(audioCtxRef.current);
      }
      if (!dcBufferRef.current) {
        dcBufferRef.current = await loadDepthChargeBuffer(audioCtxRef.current);
      }
      setAudioReady(true);
      setAudioError(null);
      return true;
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : 'Audio init failed');
      setAudioReady(false);
      return false;
    }
  }, []);

  const stopAllVoices = useCallback(() => {
    for (const voice of voicesRef.current.values()) {
      try {
        voice.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        voice.source.disconnect();
        voice.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    voicesRef.current.clear();
  }, []);

  const syncVoices = useCallback(() => {
    const ctx = audioCtxRef.current;
    const buffer = bufferRef.current;
    const master = masterGainRef.current;
    if (!ctx || !buffer || !master || ctx.state !== 'running') return;

    // Propeller loops only — active-sonar pings + depth charges use one-shot samples.
    const list = contactsRef.current.filter(
      (c) => c.kind !== 'active_sonar_ping' && c.kind !== 'depth_charge',
    );
    const bearing = listenRef.current;
    const keep = new Set(list.map((c) => c.id));

    for (const [id, voice] of [...voicesRef.current.entries()]) {
      if (!keep.has(id)) {
        try {
          voice.source.stop();
        } catch {
          /* ignore */
        }
        voice.source.disconnect();
        voice.gain.disconnect();
        voicesRef.current.delete(id);
      }
    }

    for (const c of list) {
      let voice = voicesRef.current.get(c.id);
      if (!voice) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const { playbackRate, loopStartFraction } = hydrophoneContactVoiceOffset(c.id);
        source.playbackRate.value = playbackRate;
        // Offset loop phase so overlapping contacts do not stack identically.
        const offsetSec = loopStartFraction * Math.max(0.01, buffer.duration);
        source.loopStart = offsetSec;
        source.loopEnd = buffer.duration;
        source.connect(gain);
        gain.connect(master);
        try {
          source.start(0, offsetSec);
        } catch {
          continue;
        }
        voice = { id: c.id, source, gain };
        voicesRef.current.set(c.id, voice);
      }
      const target = hydrophoneContactGain(c.rangeNm, bearing, c.bearing);
      const now = ctx.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(target, now, 0.04);
    }
  }, []);

  const playPingSamples = useCallback(async () => {
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    const pingBuffer = pingBufferRef.current;
    if (!ctx || !master || !pingBuffer || ctx.state !== 'running') return;
    const bearing = listenRef.current;
    const pings = contactsRef.current.filter((c) => c.kind === 'active_sonar_ping');
    for (const c of pings) {
      const gainAmt = hydrophoneContactGain(c.rangeNm, bearing, c.bearing);
      if (gainAmt < 0.02) continue;
      playSonarPingSample(ctx, pingBuffer, master, hydrophonePingPeakGain(gainAmt));
    }
  }, []);

  /** One-shot depth-charge detonations when new contacts appear in hearing. */
  const playDepthChargeSamples = useCallback(() => {
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    const dcBuffer = dcBufferRef.current;
    if (!ctx || !master || !dcBuffer || ctx.state !== 'running') return;
    const bearing = listenRef.current;
    const charges = contactsRef.current.filter((c) => c.kind === 'depth_charge');
    const liveIds = new Set(charges.map((c) => c.id));
    for (const id of [...playedDcIdsRef.current]) {
      if (!liveIds.has(id)) playedDcIdsRef.current.delete(id);
    }
    // New contacts in this hear-batch: one sample per charge, staggered over ~1.5 min.
    const fresh = charges
      .filter((c) => !playedDcIdsRef.current.has(c.id))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const n = fresh.length;
    for (let i = 0; i < n; i++) {
      const c = fresh[i]!;
      const gainAmt = hydrophoneContactGain(c.rangeNm, bearing, c.bearing);
      // Detonations are loud — play even off-beam at reduced gain.
      const peak = Math.max(0.04, hydrophoneDepthChargePeakGain(Math.max(gainAmt, 0.15)));
      playDepthChargeSample(ctx, dcBuffer, master, peak, {
        whenSec: depthChargeStaggerDelaySec(i, n),
      });
      playedDcIdsRef.current.add(c.id);
    }
  }, []);

  // Propeller gain tracks listen bearing / contact list; never restart ping cadence here.
  useEffect(() => {
    if (!listening) {
      stopAllVoices();
      return;
    }
    syncVoices();
    playDepthChargeSamples();
  }, [listening, contacts, listenBearing, syncVoices, stopAllVoices, playDepthChargeSamples]);

  // Active-sonar hear path: one emit cadence from the destroyer stub interval.
  // Listen bearing / gain only modulate volume inside playPingSamples (via refs) —
  // sweeping the needle must not reset the timer or fire an immediate beep (#40).
  useEffect(() => {
    if (!listening) {
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      return;
    }
    void playPingSamples();
    pingTimerRef.current = window.setInterval(
      () => void playPingSamples(),
      ACTIVE_SONAR_PING_INTERVAL_SEC * 1000,
    );
    return () => {
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    };
  }, [listening, playPingSamples]);

  const stopNudgeHold = useCallback(() => {
    if (nudgeHoldDelayRef.current != null) {
      window.clearTimeout(nudgeHoldDelayRef.current);
      nudgeHoldDelayRef.current = null;
    }
    if (nudgeHoldIntervalRef.current != null) {
      window.clearInterval(nudgeHoldIntervalRef.current);
      nudgeHoldIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopNudgeHold();
      stopAllVoices();
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current);
      }
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      pingBufferRef.current = null;
    };
  }, [stopAllVoices, stopNudgeHold]);

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const rect = el.getBoundingClientRect();
    setListenBearing(bearingFromPointer(e.clientX, e.clientY, rect));
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setListenBearing(bearingFromPointer(e.clientX, e.clientY, rect));
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (el?.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  };

  const toggleListen = async () => {
    if (listening) {
      setListening(false);
      stopAllVoices();
      return;
    }
    const ok = await ensureAudio();
    if (ok) setListening(true);
  };

  const nudgeBearing = useCallback((dir: -1 | 1) => {
    setListenBearing((prev) => normalizeHeading(Math.round(prev) + dir * BEARING_NUDGE_DEG));
  }, []);

  const startNudgeHold = (dir: -1 | 1) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture so hold-repeat continues if the pointer slides off the hit target.
    e.currentTarget.setPointerCapture(e.pointerId);
    stopNudgeHold();
    nudgeBearing(dir);
    nudgeHoldDelayRef.current = window.setTimeout(() => {
      nudgeHoldDelayRef.current = null;
      nudgeHoldIntervalRef.current = window.setInterval(() => {
        nudgeBearing(dir);
      }, NUDGE_HOLD_INTERVAL_MS);
    }, NUDGE_HOLD_DELAY_MS);
  };

  const endNudgeHold = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    stopNudgeHold();
  };

  const listenLabel = String(Math.round(listen)).padStart(3, '0');
  const hdgLabel = String(Math.round(hdg)).padStart(3, '0');
  const levelPct = Math.round(signalLevel * 100);
  const bandLabel = rangeBandLabel(rangeBand);
  const approxLabel =
    approxRangeNm == null ? '—' : `~${approxRangeNm} nm`;
  const ariaRange =
    approxRangeNm == null
      ? 'range indeterminate — train needle on the contact'
      : `approximate range ${approxRangeNm} nautical miles`;

  return (
    <div className="radar-scope radar-console hydrophone-scope">
      <div className="radar-scope-plot">
        <svg
          ref={svgRef}
          className="radar-scope-svg hydrophone-svg"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`Hydrophone listen bearing ${listenLabel} degrees. Click dial to jump needle. Intensity ${levelPct} percent. ${ariaRange}. No visual contacts — audio only.`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
            <circle
              cx={CX}
              cy={CY}
              r={R + 28}
              fill="#0a120c"
              stroke="#2a3830"
              strokeWidth={8}
            />
            <circle cx={CX} cy={CY} r={R} fill="#041208" stroke="#1a8f3c" strokeWidth={2} />
            <circle
              cx={CX}
              cy={CY}
              r={R - 48}
              fill="none"
              stroke="rgba(61,255,106,0.1)"
              strokeWidth={1}
            />

            {ticks.map((t) => (
              <g key={t.deg}>
                <line
                  x1={t.x1}
                  y1={t.y1}
                  x2={t.x2}
                  y2={t.y2}
                  stroke={t.major ? '#3dff6a' : 'rgba(61,255,106,0.4)'}
                  strokeWidth={t.major ? 2 : 1}
                />
                {t.cardinal && (
                  <text
                    x={t.tx}
                    y={t.ty}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#7dff9a"
                    fontSize={18}
                    fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
                    fontWeight={700}
                  >
                    {t.cardinal}
                  </text>
                )}
                {t.major && !t.cardinal && (
                  <text
                    x={t.tx}
                    y={t.ty}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#5a9a68"
                    fontSize={11}
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {String(t.deg).padStart(3, '0')}
                  </text>
                )}
              </g>
            ))}

            {/* Own-ship lubber — faint, not a contact. */}
            <g
              className="hydrophone-needle"
              style={{
                transform: `rotate(${hdgRotateDeg}deg)`,
                transformOrigin: `${CX}px ${CY}px`,
              }}
              opacity={0.45}
            >
              <line
                x1={CX}
                y1={CY - (R - 52)}
                x2={CX}
                y2={CY - (R - 8)}
                stroke="#7dff9a"
                strokeWidth={2}
              />
            </g>

            {/* Listen needle — operator trains this. */}
            <g
              className="hydrophone-needle"
              style={{
                transform: `rotate(${listenRotateDeg}deg)`,
                transformOrigin: `${CX}px ${CY}px`,
              }}
            >
              <line
                x1={CX}
                y1={CY + 18}
                x2={CX}
                y2={CY - (R - 10)}
                stroke="#3dff6a"
                strokeWidth={3}
              />
              <polygon
                points={`${CX},${CY - (R + 14)} ${CX - 10},${CY - (R - 2)} ${CX + 10},${CY - (R - 2)}`}
                fill="#7dff9a"
              />
              <circle cx={CX} cy={CY} r={7} fill="#041208" stroke="#3dff6a" strokeWidth={2} />
            </g>
          </svg>
      </div>

      <div className="radar-side-panel hydrophone-aux">
        <div className="hydrophone-readouts">
          <div className="hydrophone-readout">
            <span className="hydrophone-key">LSTN</span>
            <span className="readout hydrophone-val">{listenLabel}°</span>
          </div>
          <div className="hydrophone-readout">
            <span className="hydrophone-key">HDG</span>
            <span className="readout hydrophone-val">{hdgLabel}°</span>
          </div>
          <div className="hydrophone-readout">
            <span className="hydrophone-key">INT</span>
            <span className="readout hydrophone-val">{levelPct}%</span>
          </div>
          <div className="hydrophone-readout">
            <span className="hydrophone-key">RNG</span>
            <span
              className={`readout hydrophone-val hydrophone-band hydrophone-band--${rangeBand}`}
            >
              {approxLabel}
            </span>
          </div>
          {rangeBand !== 'none' && (
            <div className="hydrophone-readout hydrophone-readout--band">
              <span className="hydrophone-key">BAND</span>
              <span className="readout hydrophone-val hydrophone-band-label">{bandLabel}</span>
            </div>
          )}
        </div>

        <div
          className="hydrophone-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={levelPct}
          aria-label="Hydrophone signal intensity"
        >
          <div className="hydrophone-meter-fill" style={{ width: `${levelPct}%` }} />
        </div>
        <div className="hydrophone-meter-scale" aria-hidden>
          <span>weak</span>
          <span>strong</span>
        </div>

        <div className="hydrophone-controls">
          <button
            type="button"
            className={listening ? 'primary' : undefined}
            onClick={() => void toggleListen()}
          >
            {listening ? 'Stop listening' : 'Start listening'}
          </button>
          <div className="hydrophone-fine">
            <span className="hydrophone-key">Train · hold · {BEARING_NUDGE_DEG}°</span>
            <div className="hydrophone-fine-row">
              <button
                type="button"
                className="hydrophone-nudge"
                aria-label={`Decrease listen bearing ${BEARING_NUDGE_DEG} degree. Hold to repeat.`}
                onPointerDown={startNudgeHold(-1)}
                onPointerUp={endNudgeHold}
                onPointerCancel={endNudgeHold}
                onLostPointerCapture={stopNudgeHold}
                onClick={(e) => {
                  /* Keyboard activation only — pointer path already nudged on down. */
                  if (e.detail === 0) nudgeBearing(-1);
                }}
              >
                ◀
              </button>
              <button
                type="button"
                className="hydrophone-nudge"
                aria-label={`Increase listen bearing ${BEARING_NUDGE_DEG} degree. Hold to repeat.`}
                onPointerDown={startNudgeHold(1)}
                onPointerUp={endNudgeHold}
                onPointerCancel={endNudgeHold}
                onLostPointerCapture={stopNudgeHold}
                onClick={(e) => {
                  if (e.detail === 0) nudgeBearing(1);
                }}
              >
                ▶
              </button>
            </div>
          </div>
        </div>

        <p className="hydrophone-caption muted mono">
          Click dial to jump · hold ◀▶ to train · RNG ≈ invert range falloff (R0=8 nm) when needle
          is on contact · ~nm coarsened · max {maxRangeNm} nm ·{' '}
          {contacts.length === 0
            ? 'no acoustic contacts in range'
            : `${contacts.filter((c) => c.kind !== 'active_sonar_ping').length} prop · ${contacts.filter((c) => c.kind === 'active_sonar_ping').length} ping (audio only)`}
          {listening && audioReady ? ' · LIVE' : ''}
        </p>
        {audioError && <p className="error">{audioError}</p>}
      </div>
    </div>
  );
}

export const HydrophoneScope = memo(HydrophoneScopeInner);
