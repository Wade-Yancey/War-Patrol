import type { ReactNode } from 'react';

type Side = 'blue' | 'red' | 'neutral' | undefined;

/** CRT bezel + screen; sets data-side for phosphor tint. */
export function CrtShell({
  side = 'neutral',
  children,
}: {
  side?: Side;
  children: ReactNode;
}) {
  const dataSide = side === 'blue' || side === 'red' ? side : undefined;

  return (
    <div className="crt-bezel" data-side={dataSide}>
      <div className="crt-screen fade-in">{children}</div>
    </div>
  );
}
