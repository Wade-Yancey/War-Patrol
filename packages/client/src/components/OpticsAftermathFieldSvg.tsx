/**
 * CRT sea-clutter glyphs for sink-aftermath Sightings (oil / debris / rafts / pilot).
 * Naval-instrument language over the periscope / lookout sea plane — not cartoon.
 */
import type { OpticsSightingKind } from '@war-patrol/shared';

export type AftermathFieldKind = Exclude<OpticsSightingKind, 'wake'>;

interface Props {
  /** Primary selected Sighting kind. */
  kind: AftermathFieldKind;
  /**
   * Extra layers when FoW also detected sibling clutter on the same LOS
   * (e.g. OIL selected but DEBRIS also in range → show both).
   */
  also?: readonly AftermathFieldKind[];
  className?: string;
}

function layersFor(kind: AftermathFieldKind, also: readonly AftermathFieldKind[]): AftermathFieldKind[] {
  const set = new Set<AftermathFieldKind>([kind, ...also]);
  // Paint order: oil under debris under rafts / pilot.
  const order: AftermathFieldKind[] = ['oil', 'debris', 'life_rafts', 'downed_pilot'];
  return order.filter((k) => set.has(k));
}

function OilSlick() {
  return (
    <g className="optics-aftermath-oil" aria-hidden>
      {/* Soft sheen — muted umber on the sea, irregular oval */}
      <ellipse cx="120" cy="78" rx="72" ry="22" fill="rgba(18, 28, 22, 0.42)" />
      <ellipse cx="118" cy="76" rx="54" ry="14" fill="rgba(28, 38, 30, 0.28)" />
      <path
        d="M52 80 C70 62, 100 58, 128 66 C152 72, 176 78, 188 86 C170 92, 140 96, 108 94 C80 92, 58 88, 52 80 Z"
        fill="rgba(12, 20, 16, 0.35)"
      />
      {/* Thin instrument edge — not a rainbow slick */}
      <ellipse
        cx="120"
        cy="78"
        rx="70"
        ry="20"
        fill="none"
        stroke="rgba(32, 48, 38, 0.55)"
        strokeWidth="1.25"
        strokeDasharray="5 7"
      />
    </g>
  );
}

function DebrisField() {
  return (
    <g className="optics-aftermath-debris" aria-hidden>
      <rect x="78" y="70" width="10" height="3.5" rx="0.5" fill="rgba(10, 18, 24, 0.78)" transform="rotate(-12 83 72)" />
      <rect x="98" y="74" width="7" height="2.5" rx="0.4" fill="rgba(10, 18, 24, 0.7)" transform="rotate(18 101 75)" />
      <rect x="128" y="68" width="12" height="3" rx="0.5" fill="rgba(10, 18, 24, 0.75)" transform="rotate(-8 134 70)" />
      <rect x="148" y="76" width="8" height="2.8" rx="0.4" fill="rgba(10, 18, 24, 0.68)" transform="rotate(22 152 77)" />
      <rect x="108" y="82" width="6" height="2.2" rx="0.3" fill="rgba(10, 18, 24, 0.62)" transform="rotate(-25 111 83)" />
      <rect x="160" y="70" width="5" height="2" rx="0.3" fill="rgba(10, 18, 24, 0.55)" transform="rotate(8 162 71)" />
      <circle cx="90" cy="78" r="1.4" fill="rgba(10, 18, 24, 0.65)" />
      <circle cx="140" cy="84" r="1.2" fill="rgba(10, 18, 24, 0.6)" />
      <circle cx="118" cy="66" r="1.1" fill="rgba(10, 18, 24, 0.55)" />
    </g>
  );
}

function LifeRafts() {
  return (
    <g className="optics-aftermath-rafts" aria-hidden>
      {[
        [92, 74],
        [118, 80],
        [146, 72],
      ].map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <ellipse cx="0" cy="0" rx="7" ry="3.2" fill="none" stroke="rgba(12, 22, 28, 0.75)" strokeWidth="1.4" />
          <line x1="-4" y1="0" x2="4" y2="0" stroke="rgba(12, 22, 28, 0.45)" strokeWidth="0.8" />
        </g>
      ))}
    </g>
  );
}

function DownedPilot() {
  return (
    <g className="optics-aftermath-pilot" aria-hidden>
      <circle cx="120" cy="76" r="3.2" fill="none" stroke="rgba(12, 22, 28, 0.8)" strokeWidth="1.3" />
      <line x1="120" y1="70" x2="120" y2="84" stroke="rgba(12, 22, 28, 0.7)" strokeWidth="1.2" />
      <line x1="114" y1="76" x2="126" y2="76" stroke="rgba(12, 22, 28, 0.7)" strokeWidth="1.2" />
    </g>
  );
}

export function OpticsAftermathFieldSvg({ kind, also = [], className }: Props) {
  const layers = layersFor(kind, also);
  const label =
    kind === 'oil'
      ? 'Oil slick'
      : kind === 'debris'
        ? 'Debris field'
        : kind === 'life_rafts'
          ? 'Life rafts'
          : 'Downed pilot';

  return (
    <svg
      className={className}
      viewBox="0 0 240 120"
      width={240}
      height={120}
      role="img"
      aria-label={label}
      focusable="false"
    >
      {layers.includes('oil') && <OilSlick />}
      {layers.includes('debris') && <DebrisField />}
      {layers.includes('life_rafts') && <LifeRafts />}
      {layers.includes('downed_pilot') && <DownedPilot />}
    </svg>
  );
}

export function isAftermathSightingKind(kind: OpticsSightingKind): kind is AftermathFieldKind {
  return kind !== 'wake';
}
