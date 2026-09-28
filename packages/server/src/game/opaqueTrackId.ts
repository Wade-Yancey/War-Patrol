/**
 * Stable opaque FoW track id — FNV-1a over joined parts.
 * Not reversible to unit ids without knowing the salt parts.
 */
export function opaqueTrackId(parts: string[]): string {
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
