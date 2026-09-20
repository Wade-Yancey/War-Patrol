import { DIVE_PRESETS, formatDepthMeters, type DivePresetId } from '@war-patrol/shared';
import { TouchNumber } from './TouchNumber';

export interface DiveControlsProps {
  /** Actual keel depth (m). */
  depth: number;
  /** Standing ordered depth set-point (m). */
  orderedDepth: number;
  /** Draft depth on the control (pre-submit). */
  draftDepth: number;
  onDraftDepthChange: (depthM: number) => void;
  maxDepthM: number;
  disabled?: boolean;
  onSubmit: (depthM: number) => void;
}

/**
 * Submarine dive panel: preset depth buttons + touch depth setter.
 * Ships never render this — depth is surface-only for them.
 */
export function DiveControls({
  depth,
  orderedDepth,
  draftDepth,
  onDraftDepthChange,
  maxDepthM,
  disabled = false,
  onSubmit,
}: DiveControlsProps) {
  const depthLabel = formatDepthMeters(depth);
  const orderedLabel = formatDepthMeters(orderedDepth);
  const draftLabel = formatDepthMeters(draftDepth);
  const onOrdered = Math.round(depth) === Math.round(orderedDepth);

  const applyPreset = (id: DivePresetId) => {
    const preset = DIVE_PRESETS.find((p) => p.id === id);
    if (!preset || disabled) return;
    onDraftDepthChange(preset.depthM);
    onSubmit(preset.depthM);
  };

  return (
    <div className="dive-controls">
      <div className="dive-readouts" aria-live="polite">
        <div className="dive-readout">
          <span className="dive-key">DEPTH</span>
          <span className="readout dive-val">{depthLabel}</span>
        </div>
        <div className="dive-readout">
          <span className="dive-key">ORDERED</span>
          <span className="readout dive-val">{orderedLabel}</span>
          {onOrdered && <span className="dive-ok">ON</span>}
        </div>
        {Math.round(draftDepth) !== Math.round(orderedDepth) && (
          <div className="dive-readout dive-readout--draft">
            <span className="dive-key">SET</span>
            <span className="readout dive-val">{draftLabel}</span>
          </div>
        )}
      </div>

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
        step={1}
        unit="m"
        disabled={disabled}
        format={(v) => formatDepthMeters(v)}
        parse={(raw) => {
          const n = Number(String(raw).replace(/[^\d.-]/g, ''));
          return Number.isFinite(n) ? n : null;
        }}
        hint={`Tap readout to type · 0–${maxDepthM} m`}
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

      <p className="dive-caption muted mono">
        Ordered depth rings up now; keel depth approaches ordered over resolves. Max{' '}
        {maxDepthM} m.
      </p>
    </div>
  );
}
