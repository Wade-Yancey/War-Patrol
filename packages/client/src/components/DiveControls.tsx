import {
  DIVE_BAND_MARKS,
  DIVE_PRESETS,
  FLEET_SUB_CRUSH_DEPTH_M,
  FLEET_SUB_TEST_DEPTH_M,
  SUBMARINE_DEPTH_ORDER_STEP_M,
  SUBMARINE_MAX_DEPTH_M,
  formatCoarseDepthMeters,
  submarineDepthRisk,
  type DivePresetId,
} from '@war-patrol/shared';
import { TouchNumber } from './TouchNumber';

export interface DiveControlsProps {
  /** Actual keel depth (m). */
  depth: number;
  /** Standing ordered depth set-point (m). */
  orderedDepth: number;
  /** Draft depth on the control (pre-submit). */
  draftDepth: number;
  onDraftDepthChange: (depthM: number) => void;
  maxDepthM?: number;
  orderStepM?: number;
  disabled?: boolean;
  onSubmit: (depthM: number) => void;
}

/**
 * Submarine dive panel: preset depth buttons + coarse touch depth setter.
 * Ships never render this — depth is surface-only for them.
 */
export function DiveControls({
  depth,
  orderedDepth,
  draftDepth,
  onDraftDepthChange,
  maxDepthM = SUBMARINE_MAX_DEPTH_M,
  orderStepM = SUBMARINE_DEPTH_ORDER_STEP_M,
  disabled = false,
  onSubmit,
}: DiveControlsProps) {
  const depthLabel = formatCoarseDepthMeters(depth);
  const orderedLabel = formatCoarseDepthMeters(orderedDepth);
  const draftLabel = formatCoarseDepthMeters(draftDepth);
  const coarseDepth = Math.round(depth / orderStepM) * orderStepM;
  const coarseOrdered = Math.round(orderedDepth / orderStepM) * orderStepM;
  const coarseDraft = Math.round(draftDepth / orderStepM) * orderStepM;
  const onOrdered = coarseDepth === coarseOrdered;

  const draftRisk = submarineDepthRisk(draftDepth);
  const keelRisk = submarineDepthRisk(depth);

  const applyPreset = (id: DivePresetId) => {
    const preset = DIVE_PRESETS.find((p) => p.id === id);
    if (!preset || disabled) return;
    onDraftDepthChange(preset.depthM);
    onSubmit(preset.depthM);
  };

  const riskBanner =
    draftRisk === 'past_crush' || keelRisk === 'past_crush'
      ? `PAST CRUSH (>${FLEET_SUB_CRUSH_DEPTH_M} m) — implosion risk each resolve`
      : draftRisk === 'at_crush' || keelRisk === 'at_crush'
        ? `AT CRUSH (${FLEET_SUB_CRUSH_DEPTH_M} m) — hull at limit; go deeper and you may implode`
        : draftRisk === 'below_test' || keelRisk === 'below_test'
          ? `BELOW TEST (>${FLEET_SUB_TEST_DEPTH_M} m) — into risk band toward crush`
          : null;

  return (
    <div className="dive-controls">
      <div className="crt-console-readouts dive-readouts" aria-live="polite">
        <div className="crt-console-readout dive-readout">
          <span className="crt-console-key dive-key">DEPTH</span>
          <span className="readout crt-console-val dive-val">{depthLabel}</span>
        </div>
        <div className="crt-console-readout dive-readout">
          <span className="crt-console-key dive-key">ORDERED</span>
          <span className="readout crt-console-val dive-val">{orderedLabel}</span>
          {onOrdered && <span className="dive-ok">ON</span>}
        </div>
        {coarseDraft !== coarseOrdered && (
          <div className="crt-console-readout dive-readout dive-readout--draft">
            <span className="crt-console-key dive-key">SET</span>
            <span className="readout crt-console-val dive-val">{draftLabel}</span>
          </div>
        )}
      </div>

      <div className="dive-bands" role="group" aria-label="Depth band marks">
        {DIVE_BAND_MARKS.map((mark) => {
          const active = coarseDraft === mark.depthM || coarseDepth === mark.depthM;
          return (
            <div
              key={mark.id}
              className={[
                'dive-band-mark',
                `dive-band-mark--${mark.id}`,
                active ? 'dive-band-mark--active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={`${mark.label} depth ${mark.depthM} m`}
            >
              <span className="dive-band-label">{mark.label}</span>
              <span className="dive-band-depth mono">{mark.depthM} m</span>
            </div>
          );
        })}
      </div>

      {riskBanner && (
        <p
          className={[
            'dive-risk',
            draftRisk === 'past_crush' || keelRisk === 'past_crush'
              ? 'dive-risk--critical'
              : 'dive-risk--warn',
          ].join(' ')}
          role="status"
        >
          {riskBanner}
        </p>
      )}

      <div className="dive-presets" role="group" aria-label="Dive depth presets">
        {DIVE_PRESETS.map((preset) => {
          const active = Math.round(draftDepth) === preset.depthM;
          const isEmergency = preset.id === 'emergency_blow';
          return (
            <button
              key={preset.id}
              type="button"
              className={[
                'dive-preset',
                active ? 'active' : '',
                isEmergency ? 'dive-preset--emergency' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={disabled}
              title={`${preset.label}: ${preset.depthM} m — ${preset.rationale}`}
              onClick={() => applyPreset(preset.id)}
            >
              <span className="dive-preset-label">{preset.label}</span>
              <span className="dive-preset-depth mono">{preset.depthM} m</span>
            </button>
          );
        })}
      </div>

      <TouchNumber
        label="Ordered depth"
        value={draftDepth}
        onChange={onDraftDepthChange}
        min={0}
        max={maxDepthM}
        step={orderStepM}
        unit="m"
        disabled={disabled}
        format={(v) => formatCoarseDepthMeters(v)}
        parse={(raw) => {
          const n = Number(String(raw).replace(/[^\d.-]/g, ''));
          return Number.isFinite(n) ? n : null;
        }}
        hint={`${orderStepM} m steps · 0–${maxDepthM} m`}
      />

      <div className="control-actions">
        <button
          className="primary"
          type="button"
          disabled={disabled}
          onClick={() => onSubmit(draftDepth)}
        >
          Submit depth
        </button>
      </div>

      <p className="crt-console-caption dive-caption muted mono">
        Patrol {DIVE_BAND_MARKS[0].depthM} · test {DIVE_BAND_MARKS[1].depthM} · crush{' '}
        {DIVE_BAND_MARKS[2].depthM} m · max {maxDepthM} m
      </p>
    </div>
  );
}
