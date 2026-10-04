/**
 * Shared waiting / countdown / rearm magazine FSM used by depth-charge racks,
 * deck guns, and (per-room) torpedo magazines.
 *
 * Weapon-specific wrappers map UnitState fields onto this slice so reload rules
 * stay in one place.
 */

export type MagazineSlice = {
  load: number;
  awaitingReload: boolean;
  reloadTurnsRemaining: number;
};

/** Empty magazine (ineligible hull or cleared). */
export function emptyMagazine(): MagazineSlice {
  return { load: 0, awaitingReload: false, reloadTurnsRemaining: 0 };
}

/** Clamp load / awaiting / countdown from partial save fields. */
export function resolveMagazineSlice(opts: {
  eligible: boolean;
  capacity: number;
  load?: number;
  awaitingReload?: boolean;
  reloadTurnsRemaining?: number;
}): MagazineSlice {
  if (!opts.eligible) return emptyMagazine();
  const capacity = Math.max(0, Math.floor(opts.capacity));
  const load =
    typeof opts.load === 'number'
      ? Math.min(capacity, Math.max(0, Math.floor(opts.load)))
      : capacity;
  return {
    load,
    awaitingReload: Boolean(opts.awaitingReload),
    reloadTurnsRemaining: Math.max(
      0,
      Math.floor(Number(opts.reloadTurnsRemaining) || 0),
    ),
  };
}

/** True when the magazine can expend rounds (not sunk; optionally not awaiting / counting down). */
export function magazineReadyToFire(opts: {
  eligible: boolean;
  sunk: boolean;
  load: number;
  awaitingReload: boolean;
  reloadTurnsRemaining: number;
  /** Extra gate (e.g. deck-gun depth). Default true. */
  extraOk?: boolean;
  /**
   * When false, remaining ready rounds stay fireable while awaiting / mid reload
   * (depth-charge rack + torpedo rooms). Default true (deck gun still locks).
   */
  blockWhileReloading?: boolean;
}): boolean {
  if (!opts.eligible) return false;
  if (opts.sunk) return false;
  if (opts.extraOk === false) return false;
  if (opts.blockWhileReloading !== false) {
    if (opts.awaitingReload) return false;
    if ((opts.reloadTurnsRemaining ?? 0) > 0) return false;
  }
  return opts.load > 0;
}

/** Subtract rounds and mark awaiting player reload. */
export function consumeMagazineLoad(
  slice: MagazineSlice,
  count: number,
): MagazineSlice {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return slice;
  return {
    ...slice,
    load: Math.max(0, slice.load - n),
    awaitingReload: true,
  };
}

export type MagazineReloadResult =
  | { ok: true; reloadTurnsRemaining: number }
  | { ok: false; error: string };

/** Start a reload countdown (player pressed Reload). */
export function startMagazineReload(opts: {
  eligible: boolean;
  sunk: boolean;
  awaitingReload: boolean;
  reloadTurnsRemaining: number;
  reloadTurns: number;
  messages: {
    ineligible: string;
    sunk: string;
    notAwaiting: string;
    alreadyReloading: string;
  };
}): MagazineReloadResult {
  if (!opts.eligible) return { ok: false, error: opts.messages.ineligible };
  if (opts.sunk) return { ok: false, error: opts.messages.sunk };
  if (!opts.awaitingReload) return { ok: false, error: opts.messages.notAwaiting };
  if (opts.reloadTurnsRemaining > 0) {
    return { ok: false, error: opts.messages.alreadyReloading };
  }
  return {
    ok: true,
    reloadTurnsRemaining: Math.max(0, Math.floor(opts.reloadTurns)),
  };
}

/** Tick one resolve; clear awaiting when the countdown finishes. */
export function advanceMagazineReload(slice: MagazineSlice): MagazineSlice {
  const turns = Math.max(0, Math.floor(Number(slice.reloadTurnsRemaining) || 0));
  if (turns <= 0) return slice;
  const remaining = turns - 1;
  return {
    ...slice,
    reloadTurnsRemaining: remaining,
    ...(remaining === 0 ? { awaitingReload: false } : {}),
  };
}

/** Umpire fiat: full magazine; clear reload state (or empty if ineligible). */
export function rearmMagazine(opts: {
  eligible: boolean;
  capacity: number;
}): MagazineSlice {
  if (!opts.eligible) return emptyMagazine();
  return {
    load: Math.max(0, Math.floor(opts.capacity)),
    awaitingReload: false,
    reloadTurnsRemaining: 0,
  };
}
