import type { Coordinates, RoadSignal } from './api/types';
import { EARTH_RADIUS_METERS, bearingDegrees, haversineDistanceMeters, toRadians } from './geo';

/**
 * A street a user actually drives on a regular basis, per
 * docs/ROAD_ALERTS_DESIGN.md's privacy model -- `weight` is
 * recency-weighted over the last few months, not a flat lifetime count,
 * and only crosses into existence here once it's past the "high enough
 * to keep" threshold (a one-off trip never becomes a WeightedPoint at
 * all). `tlid` ties it back to a `streets` segment when known; matching
 * itself only needs the coordinate.
 */
export type WeightedPoint = Coordinates & {
  tlid?: string;
  weight: number;
};

export type WeightedPointMatchOptions = {
  /** Points weighted below this are treated as not routine enough to alert on. */
  minWeight?: number;
  /** Corridor half-width around the user->point path, in meters -- wide enough to cover "on this road", not a parallel one. */
  corridorMeters?: number;
  /** Points farther than this from the user aren't "reachable soon" -- mirrors RoadAlertsForm.tsx's RADIUS_METERS. */
  maxPointDistanceMeters?: number;
};

export const DEFAULT_MATCH_OPTIONS: Required<WeightedPointMatchOptions> = {
  minWeight: 0,
  corridorMeters: 300,
  maxPointDistanceMeters: 10000,
};

export type TriggeredAlert = {
  signal: RoadSignal;
  matchedPoint: WeightedPoint;
  distanceAlongPathMeters: number;
};

/**
 * Signed angular cross-track distance of `target` from the great-circle
 * path `user` -> `point`, in radians (Aviation Formulary's cross-track
 * formula). Positive/negative indicates which side of the path `target`
 * falls on; only the magnitude matters to callers here.
 */
function angularCrossTrack(user: Coordinates, point: Coordinates, target: Coordinates): number {
  const angularDistanceToTarget = haversineDistanceMeters(user, target) / EARTH_RADIUS_METERS;
  const bearingToTarget = toRadians(bearingDegrees(user, target));
  const bearingToPoint = toRadians(bearingDegrees(user, point));
  return Math.asin(Math.sin(angularDistanceToTarget) * Math.sin(bearingToTarget - bearingToPoint));
}

/**
 * Signed angular distance along the `user` -> `point` path to `target`'s
 * nearest point on that path, in radians -- negative when `target` is
 * behind the user. `acos` alone (the textbook Aviation Formulary
 * along-track formula) always returns a non-negative principal value, so
 * it can't by itself tell "behind" from "ahead"; the sign comes from
 * whether `target`'s bearing from the user is within 90 degrees of the
 * path's own bearing. Clamped into acos's domain -- without it,
 * floating-point error can push the ratio a hair past 1 when `target`
 * sits almost exactly on the path, producing NaN.
 */
function angularAlongTrack(user: Coordinates, point: Coordinates, target: Coordinates): number {
  const angularDistanceToTarget = haversineDistanceMeters(user, target) / EARTH_RADIUS_METERS;
  const crossTrack = angularCrossTrack(user, point, target);
  const ratio = Math.cos(angularDistanceToTarget) / Math.cos(crossTrack);
  const magnitude = Math.acos(Math.min(1, Math.max(-1, ratio)));

  const bearingToTarget = toRadians(bearingDegrees(user, target));
  const bearingToPoint = toRadians(bearingDegrees(user, point));
  const isForward = Math.cos(bearingToTarget - bearingToPoint) >= 0;
  return isForward ? magnitude : -magnitude;
}

/** Perpendicular distance from `target` to the straight (great-circle) path `user` -> `point`, in meters. */
export function crossTrackDistanceMeters(user: Coordinates, point: Coordinates, target: Coordinates): number {
  return Math.abs(angularCrossTrack(user, point, target)) * EARTH_RADIUS_METERS;
}

/** Distance from `user` along the path toward `point` to `target`'s nearest point on that path, in meters. */
export function alongTrackDistanceMeters(user: Coordinates, point: Coordinates, target: Coordinates): number {
  return angularAlongTrack(user, point, target) * EARTH_RADIUS_METERS;
}

/**
 * Whether `target` (a hazard) lies "in the middle" of the `user` ->
 * `point` (a weighted point) path: inside the corridor, not past the
 * point, and not behind the user. `user` and `point` coinciding has no
 * defined path, so it's treated as no match rather than throwing.
 */
export function hazardBetweenUserAndPoint(
  user: Coordinates,
  point: Coordinates,
  target: Coordinates,
  corridorMeters: number = DEFAULT_MATCH_OPTIONS.corridorMeters
): boolean {
  const pathDistanceMeters = haversineDistanceMeters(user, point);
  if (pathDistanceMeters === 0) return false;
  if (crossTrackDistanceMeters(user, point, target) > corridorMeters) return false;
  const alongTrack = alongTrackDistanceMeters(user, point, target);
  return alongTrack >= 0 && alongTrack <= pathDistanceMeters;
}

/**
 * Cross-references live hazard signals against the user's routine
 * (weighted) streets -- the "does a jeopardizing point sit between the
 * user and somewhere they usually go" calculation from
 * docs/ROAD_ALERTS_DESIGN.md's Real-time matching section. A signal
 * matching more than one weighted point is only returned once, attached
 * to whichever point it was reached through first -- callers that care
 * about ranking should sort `weightedPoints` by weight descending before
 * calling.
 */
export function findAlertsForWeightedPoints(
  user: Coordinates,
  weightedPoints: WeightedPoint[],
  signals: RoadSignal[],
  options: WeightedPointMatchOptions = {}
): TriggeredAlert[] {
  const { minWeight, corridorMeters, maxPointDistanceMeters } = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const triggeredBySignalId = new Map<string, TriggeredAlert>();

  for (const point of weightedPoints) {
    if (point.weight < minWeight) continue;
    if (haversineDistanceMeters(user, point) > maxPointDistanceMeters) continue;

    for (const signal of signals) {
      if (triggeredBySignalId.has(signal.id)) continue;
      if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') continue;
      const target = { latitude: signal.latitude, longitude: signal.longitude };
      if (!hazardBetweenUserAndPoint(user, point, target, corridorMeters)) continue;

      triggeredBySignalId.set(signal.id, {
        signal,
        matchedPoint: point,
        distanceAlongPathMeters: alongTrackDistanceMeters(user, point, target),
      });
    }
  }

  return [...triggeredBySignalId.values()];
}
