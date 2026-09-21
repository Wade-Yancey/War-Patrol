import { EOT_LABELS } from './eot.js';
import type { UnitOrders, UnitState } from './types.js';
import { isV1PlayerUnit } from './vessel.js';

/** True when the unit has filed helm, EOT, depth, and/or weapons for the current turn. */
export function hasPendingOrders(orders: UnitOrders | undefined | null): boolean {
  if (!orders) return false;
  return (
    orders.course !== undefined ||
    orders.eot !== undefined ||
    orders.depth !== undefined ||
    orders.fireTorpedo !== undefined ||
    orders.dropDepthCharges !== undefined
  );
}

/** Format course degrees true as a compact CRT readout (e.g. `045°`). */
export function formatCourseDegrees(course: number): string {
  const n = ((Math.round(course) % 360) + 360) % 360;
  return `${String(n).padStart(3, '0')}°`;
}

/** Format depth meters as a compact CRT readout (e.g. `050 m`). */
export function formatDepthMeters(depthM: number): string {
  return `${String(Math.round(depthM)).padStart(3, '0')} m`;
}

function formatTorpedoOrderSummary(
  fire: NonNullable<UnitOrders['fireTorpedo']>,
): string {
  const count = Math.max(1, Math.floor(fire.spreadCount || 1));
  const spread =
    count > 1
      ? ` ×${count}@${Math.round(fire.spreadDeg || 0)}°`
      : '';
  const room = fire.room === 'aft' ? 'aft' : 'fwd';
  return `TORP ${room} aim ${formatCourseDegrees(fire.aimHeading)}${spread} · CRS ${formatCourseDegrees(fire.estimatedCourse)} · ${Math.round(fire.estimatedSpeedKn)}kn · ${fire.estimatedRangeNm.toFixed(1)}nm · L${Math.round(fire.estimatedLengthM)}m`;
}

function formatDepthChargeOrderSummary(
  drop: NonNullable<UnitOrders['dropDepthCharges']>,
): string {
  const pat =
    drop.pattern === 'pattern_5'
      ? 'P10'
      : drop.pattern === 'pattern_3'
        ? 'P6'
        : drop.pattern === 'pair'
          ? 'PAIR4'
          : '1';
  return `DC ${pat} · SET ${formatDepthMeters(drop.depthSettingM)}`;
}

/**
 * Compact of-record summary for a unit's in-progress orders.
 * Missing halves show as `—` so the umpire sees partial submissions.
 */
export function formatPendingOrdersSummary(orders: UnitOrders | undefined | null): string {
  if (!hasPendingOrders(orders)) return '—';
  const parts: string[] = [];
  parts.push(orders!.course !== undefined ? `CRS ${formatCourseDegrees(orders!.course)}` : 'CRS —');
  parts.push(orders!.eot ? EOT_LABELS[orders!.eot] : 'Engine orders —');
  if (orders!.depth !== undefined) {
    parts.push(`DPT ${formatDepthMeters(orders!.depth)}`);
  }
  if (orders!.fireTorpedo) {
    parts.push(formatTorpedoOrderSummary(orders!.fireTorpedo));
  }
  if (orders!.dropDepthCharges) {
    parts.push(formatDepthChargeOrderSummary(orders!.dropDepthCharges));
  }
  return parts.join(' · ');
}

export type PendingOrderRow = {
  unitId: string;
  name: string;
  faction: UnitState['faction'];
  submitted: boolean;
  summary: string;
  updatedByStationId?: string;
  updatedAt?: string;
  /** Standing helm set-point (may already match pending CRS). */
  orderedCourse: number;
  /** Standing depth set-point (subs; may already match pending DPT). */
  orderedDepth: number;
  /** Acknowledged EOT (pending EOT waits until resolve). */
  currentEot: UnitState['eot'];
};

/**
 * Build umpire roster rows for **v1 player vessels** only (Destroyer + Fleet Submarine).
 * NPC / non-player hulls are omitted — they have no station order flows in v1.
 * Gaps (not submitted) first, then by name.
 */
export function pendingOrderRows(units: UnitState[]): PendingOrderRow[] {
  const rows: PendingOrderRow[] = units
    .filter((u) => isV1PlayerUnit(u))
    .map((u) => ({
      unitId: u.id,
      name: u.name,
      faction: u.faction,
      submitted: hasPendingOrders(u.orders),
      summary: formatPendingOrdersSummary(u.orders),
      updatedByStationId: u.orders.updatedByStationId,
      updatedAt: u.orders.updatedAt,
      orderedCourse: u.orderedCourse,
      orderedDepth: u.orderedDepth ?? u.position.depth,
      currentEot: u.eot,
    }));
  rows.sort((a, b) => {
    if (a.submitted !== b.submitted) return a.submitted ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}
