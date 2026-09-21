/**
 * Stable FoW contact designations (Contact N).
 *
 * Numbers are assigned on first detection of a target hull by any own-ship
 * sensor and never renumbered when display order changes (range/bearing sorts).
 * The book keys by target unit id on the server only — clients receive
 * {@link labelN} on each contact, never the target id map.
 */

export type ContactBook = {
  /** Next Contact N to issue (starts at 1). */
  nextLabel: number;
  /** Target unit id → Contact N. Never sent to vessel clients. */
  byTargetId: Record<string, number>;
};

/** Own-ship shape that may hold a contact designation book. */
export type ContactBookHost = {
  contactBook?: ContactBook;
};

/**
 * Return the stable Contact N for `targetId`, assigning the next number on
 * first sighting. Mutates `own.contactBook` in place so later sensor pictures
 * (radar / periscope / sonar) share the same designation.
 */
export function ensureContactLabel(own: ContactBookHost, targetId: string): number {
  if (!own.contactBook) {
    own.contactBook = { nextLabel: 1, byTargetId: {} };
  }
  const book = own.contactBook;
  const existing = book.byTargetId[targetId];
  if (typeof existing === 'number' && existing > 0) {
    return existing;
  }
  const n = Math.max(1, Math.floor(Number(book.nextLabel) || 1));
  book.byTargetId[targetId] = n;
  book.nextLabel = n + 1;
  return n;
}

/** Normalize a persisted contact book from older saves / partial JSON. */
export function normalizeContactBook(book: ContactBook | undefined): ContactBook | undefined {
  if (!book || typeof book !== 'object') return undefined;
  const byTargetId: Record<string, number> = {};
  let maxAssigned = 0;
  for (const [id, raw] of Object.entries(book.byTargetId ?? {})) {
    const n = Math.floor(Number(raw));
    if (!id || !Number.isFinite(n) || n < 1) continue;
    byTargetId[id] = n;
    if (n > maxAssigned) maxAssigned = n;
  }
  const nextLabel = Math.max(
    maxAssigned + 1,
    Math.max(1, Math.floor(Number(book.nextLabel) || 1)),
  );
  if (Object.keys(byTargetId).length === 0 && nextLabel <= 1) return undefined;
  return { nextLabel, byTargetId };
}
