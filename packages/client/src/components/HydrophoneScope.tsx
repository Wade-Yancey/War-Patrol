import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  ACTIVE_SONAR_PING_INTERVAL_SEC,
  formatHydrophoneRangeCue,
  hydrophoneContactGain,
  hydrophoneContactVoiceOffset,
  hydrophoneListenCue,
  normalizeHeading,
  type HydrophoneAssumedSource,
  type HydrophoneContact,
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
import {
  hydrophoneReloadKnockPeakGain,
  loadTorpedoReloadKnockBuffer,
  playTorpedoReloadKnockCouplet,
} from '../audio/torpedoReloadKnock';
import { useContinuousAngle } from '../hooks/useContinuousAngle';
import { CrtTrainControl } from './CrtTrainControl';

const PROP_SAMPLE_URL = '/audio/echo-propeller.wav';
/** Bearing nudge step for ◀ / ▶ train buttons (degrees). */
const BEARING_NUDGE_DEG = 1;

interface Props {
  contacts: HydrophoneContact[];
  maxRangeNm: number;
  /** Effective hearing range after own self-noise (nm). */
  effectiveRangeNm?: number;
  /** Own-ship listen quality 0–1 (1 = quiet platform). */
  listenQuality?: number;
  /** Own-ship self-noise 0–1 (display). */
  selfNoise?: number;
  /** Own-ship heading — lubber mark only (no contact blips). */
  ownHeading: number;
  /**
   * Current game turn — reload knocks re-fire once per acoustic turn
   * while the contact remains live (start turn + linger).
   */
  turnNumber: number;
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

function assumedSourceLabel(assumed: HydrophoneAssumedSource): string {
  switch (assumed) {
    case 'flank':
      return 'FLANK';
    case 'creep':
      return 'CREEP';
    default:
      return 'UNK';
  }
}

const ASSUMED_SOURCE_OPTIONS: HydrophoneAssumedSource[] = ['flank', 'creep', 'unknown'];

type ContactVoice = {
  id: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
};

/**
 * CRT hydrophone bearing dial — audio-first (passive listen ≠ own active sonar PPI).
 * Operator trains a listen needle; Web Audio mixes looping propeller samples
 * with per-contact gain from range × beam × sourceLevel × listenQuality.
 * Active-sonar ping / DC / reload contacts use one-shot samples. No visual contacts.
 */
function HydrophoneScopeInner({
  contacts,
  maxRangeNm,
  effectiveRangeNm,
  listenQuality = 1,
  selfNoise = 0,
  ownHeading,
  turnNumber,
}: Props) {
  const [listenBearing, setListenBearing] = useState(0);
  const [listening, setListening] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Session-local loudness prior for passive range band (not persisted). */
  const [assumedSource, setAssumedSource] = useState<HydrophoneAssumedSource>('unknown');

  const svgRef = useRef<SVGSVGElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const pingBufferRef = useRef<AudioBuffer | null>(null);
  const dcBufferRef = useRef<AudioBuffer | null>(null);
  const reloadBufferRef = useRef<AudioBuffer | null>(null);
  const playedDcIdsRef = useRef<Set<string>>(new Set());
  /** Keys: `${contactId}@${turnNumber}` — couplet once per acoustic turn. */
  const playedReloadKeysRef = useRef<Set<string>>(new Set());
  const masterGainRef = useRef<GainNode | null>(null);
  const voicesRef = useRef<Map<string, ContactVoice>>(new Map());
  const listenRef = useRef(listenBearing);
  const contactsRef = useRef(contacts);
  const listenQualityRef = useRef(listenQuality);
  const turnNumberRef = useRef(turnNumber);
  const pingTimerRef = useRef<number | null>(null);
  const effRange = effectiveRangeNm ?? maxRangeNm;

  useEffect(() => {
    listenRef.current = listenBearing;
  }, [listenBearing]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    listenQualityRef.current = listenQuality;
  }, [listenQuality]);

  useEffect(() => {
    turnNumberRef.current = turnNumber;
  }, [turnNumber]);

  const hdg = normalizeHeading(ownHeading);
  const listen = normalizeHeading(listenBearing);
  const hdgRotateDeg = useContinuousAngle(hdg);
  const listenRotateDeg = useContinuousAngle(listen);

  const cue = useMemo(
    () => hydrophoneListenCue(contacts, listen, listenQuality, assumedSource),
    [contacts, listen, listenQuality, assumedSource],
  );
  const signalLevel = cue.intensity;
  const rangeBand = cue.rangeBand;

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
      if (!reloadBufferRef.current) {
        reloadBufferRef.current = await loadTorpedoReloadKnockBuffer(audioCtxRef.current);
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

    // Propeller loops only — pings / depth charges / reload use one-shot samples.
    const list = contactsRef.current.filter((c) => c.kind === 'propeller');
    const bearing = listenRef.current;
    const quality = listenQualityRef.current;
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
      const target = hydrophoneContactGain(
        c.rangeNm,
        bearing,
        c.bearing,
        c.sourceLevel ?? 1,
        quality,
      );
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
    const quality = listenQualityRef.current;
    const pings = contactsRef.current.filter((c) => c.kind === 'active_sonar_ping');
    for (const c of pings) {
      const gainAmt = hydrophoneContactGain(c.rangeNm, bearing, c.bearing, 1, quality);
      if (gainAmt < 0.02) continue;
      playSonarPingSample(ctx, pingBuffer, master, hydrophonePingPeakGain(gainAmt));
    }
  }, []);

  /**
   * One-shot depth-charge detonations when new contacts appear in hearing.
   * Played ids are retained for the component lifetime — do not prune when a
   * contact briefly leaves the live set (SSE flicker), or the batch re-fires
   * and the operator hears a looping bed instead of N discrete bangs.
   */
  const playDepthChargeSamples = useCallback(() => {
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    const dcBuffer = dcBufferRef.current;
    if (!ctx || !master || !dcBuffer || ctx.state !== 'running') return;
    const bearing = listenRef.current;
    const quality = listenQualityRef.current;
    const charges = contactsRef.current.filter((c) => c.kind === 'depth_charge');
    // New contacts in this hear-batch: one sample per charge, staggered so N
    // detonations stay countable (same spread helper as Controls bridge).
    const fresh = charges
      .filter((c) => !playedDcIdsRef.current.has(c.id))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const n = fresh.length;
    for (let i = 0; i < n; i++) {
      const c = fresh[i]!;
      const gainAmt = hydrophoneContactGain(c.rangeNm, bearing, c.bearing, 1, quality);
      // Detonations are loud — play even off-beam at reduced gain.
      const peak = Math.max(0.04, hydrophoneDepthChargePeakGain(Math.max(gainAmt, 0.15)));
      playDepthChargeSample(ctx, dcBuffer, master, peak, {
        whenSec: depthChargeStaggerDelaySec(i, n),
      });
      playedDcIdsRef.current.add(c.id);
    }
  }, []);

  /**
   * Knock couplet when a sub room-reload acoustic cue is live (FoW spike).
   * Once per contact × turn — start turn + linger, not the full 5-turn countdown.
   */
  const playReloadSamples = useCallback(() => {
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    const reloadBuffer = reloadBufferRef.current;
    if (!ctx || !master || !reloadBuffer || ctx.state !== 'running') return;
    const bearing = listenRef.current;
    const quality = listenQualityRef.current;
    const turn = turnNumberRef.current;
    const reloads = contactsRef.current.filter((c) => c.kind === 'torpedo_reload');
    const liveIds = new Set(reloads.map((c) => c.id));
    for (const key of [...playedReloadKeysRef.current]) {
      const contactId = key.slice(0, key.lastIndexOf('@'));
      if (!liveIds.has(contactId)) playedReloadKeysRef.current.delete(key);
    }
    const fresh = reloads
      .filter((c) => !playedReloadKeysRef.current.has(`${c.id}@${turn}`))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const c of fresh) {
      const key = `${c.id}@${turn}`;
      const gainAmt = hydrophoneContactGain(
        c.rangeNm,
        bearing,
        c.bearing,
        c.sourceLevel ?? 1,
        quality,
      );
      if (gainAmt < 0.03) {
        playedReloadKeysRef.current.add(key);
        continue;
      }
      playTorpedoReloadKnockCouplet(
        ctx,
        reloadBuffer,
        master,
        hydrophoneReloadKnockPeakGain(gainAmt),
      );
      playedReloadKeysRef.current.add(key);
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
    playReloadSamples();
  }, [
    listening,
    contacts,
    listenBearing,
    listenQuality,
    turnNumber,
    syncVoices,
    stopAllVoices,
    playDepthChargeSamples,
    playReloadSamples,
  ]);

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

  useEffect(() => {
    return () => {
      stopAllVoices();
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current);
      }
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      pingBufferRef.current = null;
    };
  }, [stopAllVoices]);

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

  const listenLabel = String(Math.round(listen)).padStart(3, '0');
  const hdgLabel = String(Math.round(hdg)).padStart(3, '0');
  const levelPct = Math.round(signalLevel * 100);
  const approxLabel = formatHydrophoneRangeCue(cue);
  const ariaRange =
    cue.approxRangeMinNm == null || cue.approxRangeMaxNm == null
      ? 'range indeterminate — train needle on a propeller contact'
      : cue.approxRangeMinNm === cue.approxRangeMaxNm
        ? `approximate range about ${cue.approxRangeMinNm} nautical miles under ${assumedSourceLabel(assumedSource)} assumption`
        : `approximate range ${cue.approxRangeMinNm} to ${cue.approxRangeMaxNm} nautical miles under ${assumedSourceLabel(assumedSource)} assumption`;

  return (
    <div className="radar-scope radar-console crt-console hydrophone-scope">
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
        <div className="crt-console-readouts hydrophone-readouts">
          <div className="crt-console-readout hydrophone-readout">
            <span className="crt-console-key hydrophone-key">LSTN</span>
            <span className="readout crt-console-val hydrophone-val">{listenLabel}°</span>
          </div>
          <div className="crt-console-readout hydrophone-readout">
            <span className="crt-console-key hydrophone-key">HDG</span>
            <span className="readout crt-console-val hydrophone-val">{hdgLabel}°</span>
          </div>
          <div className="crt-console-readout hydrophone-readout">
            <span className="crt-console-key hydrophone-key">INT</span>
            <span className="readout crt-console-val hydrophone-val">{levelPct}%</span>
          </div>
          <div className="crt-console-readout hydrophone-readout">
            <span className="crt-console-key hydrophone-key">QTY</span>
            <span className="readout crt-console-val hydrophone-val">
              {Math.round(listenQuality * 100)}%
            </span>
          </div>
          <div className="crt-console-readout hydrophone-readout hydrophone-readout--rng">
            <span className="crt-console-key hydrophone-key">RNG</span>
            <span
              className={`readout crt-console-val hydrophone-val hydrophone-band hydrophone-band--${rangeBand}`}
            >
              {approxLabel}
            </span>
          </div>
        </div>

        <div
          className="hydrophone-assume"
          role="group"
          aria-label="Assumed source loudness for range estimate"
        >
          <span className="crt-console-key hydrophone-key hydrophone-assume-key">ASSUME</span>
          <div className="hydrophone-assume-options">
            {ASSUMED_SOURCE_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                className={
                  assumedSource === opt
                    ? 'hydrophone-assume-btn hydrophone-assume-btn--active'
                    : 'hydrophone-assume-btn'
                }
                aria-pressed={assumedSource === opt}
                onClick={() => setAssumedSource(opt)}
              >
                {assumedSourceLabel(opt)}
              </button>
            ))}
          </div>
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
          <CrtTrainControl
            label={`Train · hold · ${BEARING_NUDGE_DEG}°`}
            onNudge={nudgeBearing}
            decreaseLabel={`Decrease listen bearing ${BEARING_NUDGE_DEG} degree. Hold to repeat.`}
            increaseLabel={`Increase listen bearing ${BEARING_NUDGE_DEG} degree. Hold to repeat.`}
          />
        </div>

        <p className="crt-console-caption hydrophone-caption muted mono">
          Eff ~{Math.round(effRange)} / {maxRangeNm} nm
          {selfNoise > 0.05 ? ` · self-noise ${Math.round(selfNoise * 100)}%` : ' · quiet hull'}
          {' · '}
          assume {assumedSourceLabel(assumedSource).toLowerCase()}
          {' · '}
          {contacts.length === 0
            ? 'no acoustic contacts in range'
            : `${contacts.filter((c) => c.kind === 'propeller').length} prop · ${contacts.filter((c) => c.kind === 'active_sonar_ping').length} ping · ${contacts.filter((c) => c.kind === 'torpedo_reload').length} reload (audio only)`}
          {listening && audioReady ? ' · LIVE' : ''}
        </p>
        {audioError && <p className="error">{audioError}</p>}
      </div>
    </div>
  );
}

export const HydrophoneScope = memo(HydrophoneScopeInner);
