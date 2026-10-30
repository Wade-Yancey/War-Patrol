import type { ReactNode } from 'react';
import type { Faction } from '@war-patrol/shared';
import { factionAccent } from '@war-patrol/shared';

type Side = 'blue' | 'red' | 'civilian' | 'neutral' | undefined;

/** CRT bezel + screen. Faction/side is a small accent stripe only — phosphor stays green. */
export function CrtShell({
  side = 'neutral',
  faction,
  children,
}: {
  side?: Side;
  faction?: Faction;
  children: ReactNode;
}) {
  const stripe = faction
    ? factionAccent(faction)
    : side === 'blue' || side === 'red' || side === 'civilian'
      ? side
      : undefined;

  return (
    <div className="crt-bezel">
      {stripe && (
        <div
          className={`side-stripe side-stripe--${stripe}`}
          aria-hidden="true"
          title={faction ? `${faction} faction` : `${stripe} side`}
        />
      )}
      <div className="crt-screen">{children}</div>
    </div>
  );
}
