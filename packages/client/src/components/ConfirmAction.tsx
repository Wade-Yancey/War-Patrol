import { useEffect, useState, type ReactNode } from 'react';

export type ConfirmActionProps = {
  title: string;
  warning: ReactNode;
  /** Accepted confirm strings (case-insensitive). E.g. ["ROLLBACK", "3"]. */
  confirmTokens: string[];
  confirmHint: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Placeholder shown in the input (defaults to first token). */
  placeholder?: string;
  onConfirm: (matchedToken: string) => void | Promise<void>;
  onCancel: () => void;
};

/**
 * Two-step destructive confirm for CRT/touch: acknowledge, then type a token.
 * ARCH-SM-13 style — no single-click destructive path.
 */
export function ConfirmAction({
  title,
  warning,
  confirmTokens,
  confirmHint,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busy = false,
  placeholder,
  onConfirm,
  onCancel,
}: ConfirmActionProps) {
  const [acked, setAcked] = useState(false);
  const [typed, setTyped] = useState('');
  const normalized = typed.trim().toUpperCase();
  const matched = confirmTokens.find((t) => t.trim().toUpperCase() === normalized) ?? null;

  useEffect(() => {
    setAcked(false);
    setTyped('');
  }, [title, confirmTokens.join('|')]);

  return (
    <div className="confirm-action panel stack" role="dialog" aria-modal="true" aria-label={title}>
      <h2 style={{ color: '#ffc8b8', margin: 0 }}>{title}</h2>
      <div className="confirm-warning">{warning}</div>

      {!acked ? (
        <div className="control-actions">
          <button type="button" className="danger hit-lg" disabled={busy} onClick={() => setAcked(true)}>
            I understand — continue
          </button>
          <button type="button" className="hit-lg" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      ) : (
        <>
          <label>
            {confirmHint}
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder ?? confirmTokens[0]}
              disabled={busy}
              autoFocus
            />
          </label>
          <div className="control-actions">
            <button
              type="button"
              className="danger hit-lg"
              disabled={busy || !matched}
              onClick={() => matched && void onConfirm(matched)}
            >
              {confirmLabel}
            </button>
            <button type="button" className="hit-lg" disabled={busy} onClick={onCancel}>
              {cancelLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
