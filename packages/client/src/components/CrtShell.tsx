import type { ReactNode } from 'react';

type Side = 'blue' | 'red' | 'neutral' | undefined;

/** CRT bezel + screen. Side is a small accent stripe only — phosphor stays green. */
export function CrtShell({
  side = 'neutral',
  children,
}: {
  side?: Side;
  children: ReactNode;
}) {
  const stripe = side === 'blue' || side === 'red' ? side : undefined;

  return (
    <div className="crt-bezel">
      {stripe && (
        <div
          className={`side-stripe side-stripe--${stripe}`}
          aria-hidden="true"
          title={`${stripe} side`}
        />
      )}
      <div className="crt-screen fade-in">{children}</div>
    </div>
  );
}
