import { METERS_PER_DEG_LAT, METERS_PER_NM } from './constants.js';
import type { BoundingBox, LatLonDepth } from './types.js';

/** Equirectangular meters-per-degree longitude at a given latitude. */
export function metersPerDegLon(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Displace a position by east/north meters (equirectangular plane). */
export function displaceMeters(
  pos: LatLonDepth,
  eastMeters: number,
  northMeters: number,
): LatLonDepth {
  const dLat = northMeters / METERS_PER_DEG_LAT;
  const dLon = eastMeters / metersPerDegLon(pos.lat);
  return {
    lat: pos.lat + dLat,
    lon: pos.lon + dLon,
    depth: pos.depth,
  };
}

/** Move along heading (degrees true) for distance meters. */
export function moveAlongHeading(
  pos: LatLonDepth,
  headingDeg: number,
  distanceMeters: number,
): LatLonDepth {
  const rad = (headingDeg * Math.PI) / 180;
  const north = Math.cos(rad) * distanceMeters;
  const east = Math.sin(rad) * distanceMeters;
  return displaceMeters(pos, east, north);
}

/** Normalize degrees into [0, 360). */
export function normalizeHeading(deg: number): number {
  const n = deg % 360;
  return n < 0 ? n + 360 : n;
}

/** Project lat/lon into 0–1 UV within an operating area bbox (for map plotting). */
export function projectToUv(
  lat: number,
  lon: number,
  area: BoundingBox,
): { u: number; v: number } {
  const u = (lon - area.minLon) / (area.maxLon - area.minLon || 1);
  const v = 1 - (lat - area.minLat) / (area.maxLat - area.minLat || 1);
  return { u, v };
}

/** Inverse of projectToUv — equirectangular UV back to geographic lat/lon (ARCH-SP-02). */
export function unprojectFromUv(u: number, v: number, area: BoundingBox): { lat: number; lon: number } {
  const lon = area.minLon + u * (area.maxLon - area.minLon);
  const lat = area.maxLat - v * (area.maxLat - area.minLat);
  return { lat, lon };
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** East/north meters from `from` to `to` on the equirectangular plane (ARCH-SP). */
export function eastNorthMeters(
  from: Pick<LatLonDepth, 'lat' | 'lon'>,
  to: Pick<LatLonDepth, 'lat' | 'lon'>,
): { east: number; north: number } {
  const north = (to.lat - from.lat) * METERS_PER_DEG_LAT;
  const east = (to.lon - from.lon) * metersPerDegLon(from.lat);
  return { east, north };
}

/**
 * Linear interpolation between two positions on the equirectangular plane
 * (lat/lon/depth each lerp independently — fine for the short, straight-line
 * per-turn moves this sim uses). `t` is clamped to [0, 1].
 */
export function lerpLatLonDepth(a: LatLonDepth, b: LatLonDepth, t: number): LatLonDepth {
  const f = clamp(t, 0, 1);
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    depth: a.depth + (b.depth - a.depth) * f,
  };
}

/** True bearing (degrees) and range (nm) from `from` to `to`. */
export function bearingRangeNm(
  from: Pick<LatLonDepth, 'lat' | 'lon'>,
  to: Pick<LatLonDepth, 'lat' | 'lon'>,
): { bearing: number; rangeNm: number } {
  const { east, north } = eastNorthMeters(from, to);
  const bearing = normalizeHeading((Math.atan2(east, north) * 180) / Math.PI);
  const rangeNm = Math.hypot(east, north) / METERS_PER_NM;
  return { bearing, rangeNm };
}
