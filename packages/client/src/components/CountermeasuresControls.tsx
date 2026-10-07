import { useEffect, useState } from 'react';
import {
  NOISEMAKER_COOLDOWN_TURNS,
  NOISEMAKER_LIFETIME_TURNS,
  SUBMARINE_DEPTH_ORDER_STEP_M,
  SUBMARINE_MAX_DEPTH_M,
  clampSubmarineDepth,
  formatCoarseDepthMeters,
  type NoisemakerDeployOrder,
  type NoisemakerTrack,
} from '@war-patrol/shared';
import { TouchNumber } from './TouchNumber';

interface Props {
  keelDepthM: number;
  cooldownTurnsRemaining?: number;
  pending?: NoisemakerDeployOrder;
  tracks?: NoisemakerTrack[];
  disabled?: boolean;
  onSubmit: (order: NoisemakerDeployOrder) => void;
  onClear?: () => void;
}

/**
 * Fleet-sub Controls · Countermeasures — deploy a stationary noisemaker at a
 * chosen depth. Cooldown between deploys; decoy stays put after resolve.
 */
export function CountermeasuresControls({
  keelDepthM,
  cooldownTurnsRemaining = 0,
  pending,
  tracks = [],
  disabled,
  onSubmit,
  onClear,
}: Props) {
  const [depthM, setDepthM] = useState(() =>
    clampSubmarineDepth(pending?.depthM ?? keelDepthM),
  );

  useEffect(() => {
    if (pending?.depthM != null) {
      setDepthM(clampSubmarineDepth(pending.depthM));
    }
  }, [pending?.depthM]);

  const cooling = cooldownTurnsRemaining > 0;
  const canDeploy = !disabled && !cooling;

  const active = tracks.filter((t) => t.status === 'active');
  const spent = tracks.filter((t) => t.status === 'spent');

  return (
    <section className="panel stack controls-weapons-panel station-instrument-panel">
      <div className="station-instrument-head">
        <h2>Countermeasures</h2>
        <p className="muted station-instrument-blurb">
          Stationary noisemaker · cooldown {NOISEMAKER_COOLDOWN_TURNS} turns ·
          active {NOISEMAKER_LIFETIME_TURNS} turns
        </p>
      </div>

      <p className="muted" role="status">
        {cooling
          ? `Cooling down — ${cooldownTurnsRemaining} turn${
              cooldownTurnsRemaining === 1 ? '' : 's'
            } left`
          : 'Ready to deploy'}
      </p>

      <TouchNumber
        label="Deploy depth"
        value={depthM}
        onChange={(d) => setDepthM(clampSubmarineDepth(d))}
        min={0}
        max={SUBMARINE_MAX_DEPTH_M}
        step={SUBMARINE_DEPTH_ORDER_STEP_M}
        unit="m"
        disabled={disabled || cooling}
        hint={`Same coarse dial as Dive Plane (${SUBMARINE_DEPTH_ORDER_STEP_M} m steps)`}
      />

      <div className="control-actions">
        <button
          className="primary"
          type="button"
          disabled={!canDeploy}
          onClick={() => onSubmit({ depthM: clampSubmarineDepth(depthM) })}
        >
          Deploy noisemaker
        </button>
        {onClear && pending && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear order
          </button>
        )}
      </div>

      {pending && (
        <p className="muted" role="status">
          Ordered: noisemaker at {formatCoarseDepthMeters(pending.depthM)} (fires on
          resolve)
        </p>
      )}

      {(active.length > 0 || spent.length > 0) && (
        <div className="stack">
          <h3 className="station-instrument-subhead">Own decoys</h3>
          <ul className="mono muted" style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {active.map((t) => (
              <li key={t.id}>
                ACTIVE · {formatCoarseDepthMeters(t.position.depth)} · turns{' '}
                {t.deployedTurn}–{t.expiresTurn - 1}
              </li>
            ))}
            {spent.slice(-4).map((t) => (
              <li key={t.id}>
                SPENT · {formatCoarseDepthMeters(t.position.depth)} · T{t.deployedTurn}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
