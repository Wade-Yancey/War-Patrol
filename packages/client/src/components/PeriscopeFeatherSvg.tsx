/**
 * Simple CRT-friendly raised-periscope / feather silhouette for DD lookout.
 * Stick mast + small head — not a hull plate. Inline SVG so it always paints.
 */
export function PeriscopeFeatherSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 120"
      width={64}
      height={120}
      role="img"
      aria-label="Periscope feather silhouette"
      focusable="false"
    >
      {/* Soft wake / base under the stick — horizon cue */}
      <ellipse cx="32" cy="108" rx="18" ry="4" fill="rgba(10, 22, 32, 0.22)" />

      {/* Mast tube */}
      <rect x="29" y="28" width="6" height="78" rx="1.5" fill="#0a1620" />

      {/* Head housing */}
      <rect x="24" y="14" width="16" height="16" rx="2" fill="#0a1620" />

      {/* Lens / eye */}
      <circle cx="32" cy="22" r="4.5" fill="#1a3040" stroke="#0a1620" strokeWidth="1.5" />
      <circle cx="32" cy="22" r="2" fill="#c8d8e4" opacity="0.85" />

      {/* Small feather / spray cue off the head */}
      <path
        d="M40 16 C48 10, 52 8, 54 6 C50 12, 46 16, 40 20 Z"
        fill="#0a1620"
        opacity="0.9"
      />
      <path
        d="M38 12 C44 6, 46 4, 48 3"
        fill="none"
        stroke="#0a1620"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}
