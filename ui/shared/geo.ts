import type { Coordinates } from './api/types';

export const EARTH_RADIUS_METERS = 6371000;

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two points, in meters. */
export function haversineDistanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from `a` to `b`, in degrees [0, 360), true north. */
export function bearingDegrees(a: Coordinates, b: Coordinates): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/**
 * Whether a point at `bearingDeg` from the driver is roughly ahead of
 * them, given their current heading -- `coneDeg` wide, centered on the
 * heading. `headingDeg` is null/undefined/negative when the device can't
 * report one (expo-location reports -1, browser geolocation reports
 * null) -- treated as "don't filter, assume ahead" per
 * docs/ROAD_ALERTS_DESIGN.md's safety-biased default (alert anyway under
 * uncertainty, rather than silently dropping a real hazard because
 * direction couldn't be determined).
 */
export function isAhead(headingDeg: number | null | undefined, bearingDeg: number, coneDeg = 90): boolean {
  if (headingDeg == null || headingDeg < 0) return true;
  const diff = Math.abs(((bearingDeg - headingDeg + 540) % 360) - 180);
  return diff <= coneDeg / 2;
}

export type TimedCoordinates = Coordinates & { timestampMs: number };

/**
 * Estimated ground speed between two GPS fixes, in meters/second -- a
 * fallback for devices/browsers that don't report
 * GeolocationCoordinates.speed themselves (desktop browsers, some
 * Android WebViews). Returns null when the fixes are simultaneous or
 * out of order, since a non-positive interval can't be divided into a
 * meaningful speed.
 */
export function estimateSpeedMetersPerSecond(previous: TimedCoordinates, current: TimedCoordinates): number | null {
  const dtSeconds = (current.timestampMs - previous.timestampMs) / 1000;
  if (dtSeconds <= 0) return null;
  return haversineDistanceMeters(previous, current) / dtSeconds;
}
