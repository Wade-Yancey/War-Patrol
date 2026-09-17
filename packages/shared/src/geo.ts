import { METERS_PER_DEG_LAT } from './constants.js';
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

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
