import { ALL_EOT_SETTINGS, EOT_LABELS, type EotSetting } from '@war-patrol/shared';
import { playEngineOrderBell } from '../audio/engineOrderBell';

interface Props {
  value: EotSetting;
  onChange: (value: EotSetting) => void;
  disabled?: boolean;
}

/** Engine-order telegraph: large stacked buttons, no native select. */
export function EotTelegraph({ value, onChange, disabled }: Props) {
  return (
    <div className="eot-telegraph" role="listbox" aria-label="Engine orders">
      {ALL_EOT_SETTINGS.map((setting, i) => {
        const active = setting === value;
        return (
          <button
            key={setting}
            type="button"
            role="option"
            aria-selected={active}
            className={active ? 'active' : undefined}
            disabled={disabled}
            onClick={() => {
              // Real telegraph move only — re-clicking the same position is a no-op (no ding).
              if (setting === value) return;
              void playEngineOrderBell();
              onChange(setting);
            }}
          >
            <span className="eot-idx">{String(i + 1).padStart(2, '0')}</span>
            {EOT_LABELS[setting]}
          </button>
        );
      })}
    </div>
  );
}
