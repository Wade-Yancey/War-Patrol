import { EOT_LABELS } from './eot.js';
import type { UnitOrders, UnitState } from './types.js';

/** True when the unit has filed helm and/or EOT for the current turn. */
export function hasPendingOrders(orders: UnitOrders | undefined | null): boolean {
  if (!orders) return false;
  return orders.course !== undefined || orders.eot !== undefined;
}

/** Format course degrees true as a compact CRT readout (e.g. `045°`). */
export function formatCourseDegrees(course: number): string {
  const n = ((Math.round(course) % 360) + 360) % 360;
  return `${String(n).padStart(3, '0')}°`;
}

/**
 * Compact of-record summary for a unit's in-progress orders.
 * Missing halves show as `—` so the umpire sees partial submissions.
 */
export function formatPendingOrdersSummary(orders: UnitOrders | undefined | null): string {
  if (!hasPendingOrders(orders)) return '—';
  const crs =
    orders!.course !== undefined ? `CRS ${formatCourseDegrees(orders!.course)}` : 'CRS —';
  const eot = orders!.eot ? EOT_LABELS[orders!.eot] : 'EOT —';
  return `${crs} · ${eot}`;
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
  /** Acknowledged EOT (pending EOT waits until resolve). */
  currentEot: UnitState['eot'];
};

/** Build umpire roster rows: gaps (not submitted) first, then by name. */
export function pendingOrderRows(units: UnitState[]): PendingOrderRow[] {
  const rows: PendingOrderRow[] = units.map((u) => ({
    unitId: u.id,
    name: u.name,
    faction: u.faction,
    submitted: hasPendingOrders(u.orders),
    summary: formatPendingOrdersSummary(u.orders),
    updatedByStationId: u.orders.updatedByStationId,
    updatedAt: u.orders.updatedAt,
    orderedCourse: u.orderedCourse,
    currentEot: u.eot,
  }));
  rows.sort((a, b) => {
    if (a.submitted !== b.submitted) return a.submitted ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}
