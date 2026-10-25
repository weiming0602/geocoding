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
