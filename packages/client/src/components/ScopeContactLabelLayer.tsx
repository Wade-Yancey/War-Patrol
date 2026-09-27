import type { ScopeLabelPlacement } from '@war-patrol/shared';

interface Props {
  placements: ScopeLabelPlacement[];
  /** Ghost layer uses dimmer phosphor; live uses bright. */
  layer: 'live' | 'ghost';
}

/**
 * CRT Contact-N label layer for polar scopes (radar PPI / active sonar cone).
 * Placement comes from layoutScopeContactLabels — this only paints.
 */
export function ScopeContactLabelLayer({ placements, layer }: Props) {
  const items = placements.filter((p) => p.kind === layer && p.visible);
  if (items.length === 0) return null;

  const isGhost = layer === 'ghost';
  return (
    <g className={`scope-contact-labels scope-contact-labels--${layer}`} aria-hidden>
      {items.map((p) => (
        <g key={`${layer}-${p.id}`}>
          {p.leader && (
            <line
              x1={p.leader.x1}
              y1={p.leader.y1}
              x2={p.leader.x2}
              y2={p.leader.y2}
              stroke={isGhost ? '#5a9a68' : '#7dff9a'}
              strokeWidth={isGhost ? 1 : 1.25}
              opacity={isGhost ? 0.35 : 0.55}
            />
          )}
          <text
            x={p.labelX}
            y={p.labelY}
            textAnchor={p.textAnchor}
            fill={isGhost ? '#5a9a68' : '#c8ffd4'}
            stroke="#041208"
            strokeWidth={isGhost ? 2 : 3}
            paintOrder="stroke"
            fontSize={p.fontSize}
            fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
          >
            {p.text}
          </text>
        </g>
      ))}
    </g>
  );
}
