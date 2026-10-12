import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnDamageEvent, VesselType } from '@war-patrol/shared';
import {
  loadTipperarySunkBuffer,
  playTipperarySunk,
  type TipperaryPlayback,
} from '../audio/tipperarySunk';

export type SunkCause = 'implosion' | 'combat' | 'unknown';

export function resolveSunkCause(damageLog: OwnDamageEvent[] | undefined): SunkCause {
  if (!damageLog?.length) return 'unknown';
  for (let i = damageLog.length - 1; i >= 0; i--) {
    const kind = damageLog[i]!.kind;
    if (kind === 'hull_implosion') return 'implosion';
    if (kind === 'unit_sunk') return 'combat';
  }
  return 'unknown';
}

function sunkTitle(vesselType: VesselType): string {
  return vesselType === 'Aircraft' ? "You've been destroyed" : "You've been sunk";
}

function sunkDetail(vesselType: VesselType, cause: SunkCause): string {
  if (cause === 'implosion') {
    return 'Pressure hull failed past crush depth. Boat lost.';
  }
  if (vesselType === 'Aircraft') {
    return 'Airframe destroyed. Unit offline.';
  }
  if (cause === 'combat') {
    return 'Catastrophic hull damage. Vessel lost.';
  }
  return 'Hull condition: sunk. Station offline for combat.';
}

export type SunkModalProps = {
  vesselName: string;
  vesselType: VesselType;
  cause: SunkCause;
  onAcknowledge: () => void;
};

/**
 * CRT station popup when own-ship condition flips to sunk.
 * Ack-only (no typed token) — ConfirmAction chrome without the two-step confirm.
 * Starts Tipperary on mount (modal already waits for blast / Dive-needle sync);
 * “Stop music” fades playback out without closing the dialog.
 */
export function SunkModal({ vesselName, vesselType, cause, onAcknowledge }: SunkModalProps) {
  const title = sunkTitle(vesselType);
  const detail = sunkDetail(vesselType, cause);
  const playbackRef = useRef<TipperaryPlayback | null>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);

  const stopMusic = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setMusicPlaying(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();

    void (async () => {
      try {
        if (ctx.state === 'suspended') await ctx.resume();
        const buffer = await loadTipperarySunkBuffer(ctx);
        if (cancelled) {
          void ctx.close();
          return;
        }
        playbackRef.current = playTipperarySunk(ctx, buffer, ctx.destination, {
          onEnded: () => {
            playbackRef.current = null;
            setMusicPlaying(false);
          },
        });
        setMusicPlaying(true);
      } catch {
        void ctx.close();
        if (!cancelled) setMusicPlaying(false);
      }
    })();

    return () => {
      cancelled = true;
      playbackRef.current?.stop();
      playbackRef.current = null;
      void ctx.close();
    };
  }, []);

  const handleAcknowledge = () => {
    stopMusic();
    onAcknowledge();
  };

  return (
    <div className="sunk-modal-backdrop" role="presentation">
      <div
        className="sunk-modal panel stack confirm-action"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sunk-modal-title"
        aria-describedby="sunk-modal-detail"
      >
        <p className="sunk-modal-eyebrow mono" aria-hidden>
          HULL LOST · {vesselName}
        </p>
        <h2 id="sunk-modal-title" className="sunk-modal-title">
          {title}
        </h2>
        <p id="sunk-modal-detail" className="confirm-warning" style={{ margin: 0 }}>
          {detail}
        </p>
        <div className="control-actions sunk-modal-actions">
          {musicPlaying ? (
            <button type="button" className="hit-lg" onClick={stopMusic}>
              Stop music
            </button>
          ) : null}
          <button type="button" className="primary hit-lg" onClick={handleAcknowledge} autoFocus>
            Acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}
