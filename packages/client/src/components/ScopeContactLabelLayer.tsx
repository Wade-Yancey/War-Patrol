import type { ScopeLabelPlacement } from '@war-patrol/shared';

interface Props {
  placements: ScopeLabelPlacement[];
}

/**
 * CRT Contact-N label layer for polar scopes (radar PPI / active sonar cone).
 * Placement comes from layoutScopeContactLabels — this only paints live Cn.
 * Ghost/shadow marks are unlabeled elsewhere on the PPI.
 */
export function ScopeContactLabelLayer({ placements }: Props) {
  const items = placements.filter((p) => p.kind === 'live' && p.visible);
  if (items.length === 0) return null;

  return (
    <g className="scope-contact-labels scope-contact-labels--live" aria-hidden>
      {items.map((p) => (
        <g key={`live-${p.id}`}>
          {p.leader && (
            <line
              x1={p.leader.x1}
              y1={p.leader.y1}
              x2={p.leader.x2}
              y2={p.leader.y2}
              stroke="#7dff9a"
              strokeWidth={1.25}
              opacity={0.55}
            />
          )}
          <text
            x={p.labelX}
            y={p.labelY}
            textAnchor={p.textAnchor}
            fill="#c8ffd4"
            stroke="#041208"
            strokeWidth={3}
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
