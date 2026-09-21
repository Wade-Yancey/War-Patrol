import type { OwnDamageEvent, VesselType } from '@war-patrol/shared';

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
 */
export function SunkModal({ vesselName, vesselType, cause, onAcknowledge }: SunkModalProps) {
  const title = sunkTitle(vesselType);
  const detail = sunkDetail(vesselType, cause);

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
        <div className="control-actions">
          <button type="button" className="primary hit-lg" onClick={onAcknowledge} autoFocus>
            Acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}
