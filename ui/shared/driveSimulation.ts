import type { Coordinates } from './api/types';
import { bearingDegrees, haversineDistanceMeters } from './geo';

// Pure, timer-free core of the Road Alerts "simulated drive" test tool
// (see ui/desktop's RoadAlertsSandbox.tsx / RoadAlerts.tsx): turns a
// street route into fake GPS fixes at a chosen speed, so the real
// fetch/match/chime pipeline can be exercised from a desk. Whoever owns
// the clock (a setInterval in RoadAlerts.tsx) just asks for the fix at
// "distance traveled so far" -- nothing here keeps state of its own.

export type DrivePlan = {
  points: Coordinates[];
  // cumulativeMeters[i] = distance along the route from points[0] to points[i]
  cumulativeMeters: number[];
  totalMeters: number;
};

export type SimulatedFix = Coordinates & {
  // Degrees clockwise from north, of the segment currently being driven.
  headingDeg: number;
  distanceMeters: number;
  // True once distanceMeters has reached the end of the route.
  done: boolean;
};

/**
 * Builds a plan from GeoJSON LineString coordinates ([lon, lat] pairs,
 * exactly what GET /road-alerts/test/drive-route returns). Consecutive
 * duplicate points are dropped so every segment has a real length (and
 * so a real heading). Throws if fewer than two distinct points remain.
 */
export function buildDrivePlan(lineCoordinates: [number, number][]): DrivePlan {
  const points: Coordinates[] = [];
  for (const [longitude, latitude] of lineCoordinates) {
    const last = points[points.length - 1];
    if (last && last.latitude === latitude && last.longitude === longitude) continue;
    points.push({ latitude, longitude });
  }
  if (points.length < 2) {
    throw new Error('A simulated drive needs a route with at least two distinct points.');
  }

  const cumulativeMeters = [0];
  for (let i = 1; i < points.length; i++) {
    cumulativeMeters.push(cumulativeMeters[i - 1] + haversineDistanceMeters(points[i - 1], points[i]));
  }
  return { points, cumulativeMeters, totalMeters: cumulativeMeters[cumulativeMeters.length - 1] };
}

/**
 * Where the simulated car is after `distanceMeters` along the plan,
 * clamped to [0, totalMeters]. Linear interpolation within a segment --
 * TIGER segments are short (tens to hundreds of meters), so the error vs.
 * a true great-circle interpolation is far below GPS noise.
 */
export function positionAlongRoute(plan: DrivePlan, distanceMeters: number): SimulatedFix {
  const { points, cumulativeMeters, totalMeters } = plan;
  const distance = Math.min(Math.max(distanceMeters, 0), totalMeters);

  // Last segment whose start is at or before `distance` (linear scan --
  // routes are at most a few thousand points, and this runs once a second).
  let i = 0;
  while (i < points.length - 2 && cumulativeMeters[i + 1] <= distance) i++;

  const from = points[i];
  const to = points[i + 1];
  const segmentLength = cumulativeMeters[i + 1] - cumulativeMeters[i];
  const t = segmentLength > 0 ? (distance - cumulativeMeters[i]) / segmentLength : 0;

  return {
    latitude: from.latitude + (to.latitude - from.latitude) * t,
    longitude: from.longitude + (to.longitude - from.longitude) * t,
    headingDeg: bearingDegrees(from, to),
    distanceMeters: distance,
    done: distance >= totalMeters,
  };
}

export const METERS_PER_SECOND_PER_MPH = 0.44704;

// Flat local-meters projection around `origin` -- fine at street scale.
function toLocalMeters(origin: Coordinates, longitude: number, latitude: number): { x: number; y: number } {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((origin.latitude * Math.PI) / 180);
  return { x: (longitude - origin.longitude) * metersPerDegLon, y: (latitude - origin.latitude) * metersPerDegLat };
}

/**
 * The part of a route ([lon, lat] pairs) still ahead of `position`: from
 * the route point nearest the car onward, starting with the car itself --
 * or null if the car is more than `maxOffRouteMeters` from the route.
 * Used when the driver switches a simulated drive onto a detour that was
 * computed a little while ago from where the car used to be: driving the
 * detour from its own first point sent the car back there and into a
 * U-turn. If the route passes the car more than once, the nearest pass
 * wins (the earliest, on a tie).
 */
export function routeAheadOf(
  position: Coordinates,
  coordinates: [number, number][],
  maxOffRouteMeters = 40
): [number, number][] | null {
  if (coordinates.length < 2) return null;
  let best: { distance: number; index: number; point: [number, number] } | null = null;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = toLocalMeters(position, ...coordinates[i]);
    const b = toLocalMeters(position, ...coordinates[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? Math.min(1, Math.max(0, -(a.x * dx + a.y * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (!best || distance < best.distance) {
      const [lon1, lat1] = coordinates[i];
      const [lon2, lat2] = coordinates[i + 1];
      best = { distance, index: i, point: [lon1 + t * (lon2 - lon1), lat1 + t * (lat2 - lat1)] };
    }
  }
  if (!best || best.distance > maxOffRouteMeters) return null;
  return [[position.longitude, position.latitude], best.point, ...coordinates.slice(best.index + 1)];
}

/**
 * Share (0-1) of route `a`'s points that lie within `withinMeters` of
 * route `b` -- how closely `a` follows `b`. Both are [lon, lat] pairs.
 */
export function routeOverlap(a: [number, number][], b: [number, number][], withinMeters = 25): number {
  if (a.length === 0 || b.length < 2) return 0;
  const near = a.filter(([longitude, latitude]) => {
    const ahead = routeAheadOf({ latitude, longitude }, b, withinMeters);
    return ahead !== null;
  });
  return near.length / a.length;
}
