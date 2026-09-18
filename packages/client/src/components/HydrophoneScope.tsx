import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  hydrophoneContactGain,
  normalizeHeading,
  type HydrophoneContact,
} from '@war-patrol/shared';

const PROP_SAMPLE_URL = '/audio/echo-propeller.wav';

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

type ContactVoice = {
  id: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
};

/**
 * CRT hydrophone bearing dial — audio-first.
 * Operator trains a listen needle; Web Audio mixes looping propeller samples
 * with per-contact gain from range × beam alignment. No visual contacts.
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
  const masterGainRef = useRef<GainNode | null>(null);
  const voicesRef = useRef<Map<string, ContactVoice>>(new Map());
  const listenRef = useRef(listenBearing);
  const contactsRef = useRef(contacts);

  useEffect(() => {
    listenRef.current = listenBearing;
  }, [listenBearing]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  const hdg = normalizeHeading(ownHeading);
  const listen = normalizeHeading(listenBearing);

  const signalLevel = useMemo(() => {
    if (contacts.length === 0) return 0;
    let peak = 0;
    for (const c of contacts) {
      peak = Math.max(peak, hydrophoneContactGain(c.rangeNm, listen, c.bearing));
    }
    return peak;
  }, [contacts, listen]);

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

    const list = contactsRef.current;
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
        source.connect(gain);
        gain.connect(master);
        try {
          source.start(0);
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

  useEffect(() => {
    if (!listening) {
      stopAllVoices();
      return;
    }
    syncVoices();
  }, [listening, contacts, listenBearing, syncVoices, stopAllVoices]);

  useEffect(() => {
    return () => {
      stopAllVoices();
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
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

  const listenLabel = String(Math.round(listen)).padStart(3, '0');
  const hdgLabel = String(Math.round(hdg)).padStart(3, '0');
  const levelPct = Math.round(signalLevel * 100);

  return (
    <div className="hydrophone-scope">
      <div
        className="hydrophone-dial"
        role="img"
        aria-label={`Hydrophone listen bearing ${listenLabel} degrees. No visual contacts — audio only.`}
      >
        <svg
          ref={svgRef}
          className="hydrophone-svg"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
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
            style={{ transform: `rotate(${hdg}deg)`, transformOrigin: `${CX}px ${CY}px` }}
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
            style={{ transform: `rotate(${listen}deg)`, transformOrigin: `${CX}px ${CY}px` }}
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
          <span className="hydrophone-key">SIG</span>
          <span className="readout hydrophone-val">{levelPct}%</span>
        </div>
      </div>

      <div className="hydrophone-meter" aria-hidden>
        <div className="hydrophone-meter-fill" style={{ width: `${levelPct}%` }} />
      </div>

      <div className="hydrophone-controls">
        <button
          type="button"
          className={listening ? 'primary' : undefined}
          onClick={() => void toggleListen()}
        >
          {listening ? 'Stop listening' : 'Start listening'}
        </button>
        <label className="hydrophone-fine">
          <span className="hydrophone-key">Fine</span>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={Math.round(listen)}
            onChange={(e) => setListenBearing(Number(e.target.value))}
            aria-label="Listen bearing fine adjust"
          />
        </label>
      </div>

      <p className="hydrophone-caption muted mono">
        Drag dial or use fine slider · max {maxRangeNm} nm ·{' '}
        {contacts.length === 0
          ? 'no underway contacts in range'
          : `${contacts.length} acoustic contact${contacts.length === 1 ? '' : 's'} (audio only)`}
        {listening && audioReady ? ' · LIVE' : ''}
      </p>
      {audioError && <p className="error">{audioError}</p>}
    </div>
  );
}

export const HydrophoneScope = memo(HydrophoneScopeInner);
