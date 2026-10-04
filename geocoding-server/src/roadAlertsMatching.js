// Plain-JS port of ui/shared/roadAlertsMatching.ts's findAlertsForWeightedPoints
// and shouldStronglyAlert, plus ui/shared/geo.ts's isAhead/bearingDegrees,
// for the background push-matching worker (scripts/road-alerts-push-worker.js)
// -- Node has no TypeScript loader here, so this can't require() the .ts
// files directly. This is a deliberate, documented duplication: if the
// matching algorithm in either ui/shared file changes, mirror the change
// here too. Same precedent as CLAUDE.md's odd/even house-number rule
// existing independently in geocoding/interpolate.py and
// geocoding-server/src/geocode.js.
//
// Only findAlertsForWeightedPoints is ported (not approachedWeightedPoints):
// the worker has a single ephemeral point per account, not a GPS trail, so
// trail-based directional narrowing has nothing to operate on -- feeding a
// single point to approachedWeightedPoints would just fall through to its
// own "not enough trail signal, return everything unfiltered" branch, so
// skipping it entirely and going straight to the geometric corridor check
// is equivalent, not a simplification of behavior.
//
// isAhead is ported too -- route-matching alone only ever alerts for a
// hazard sitting between the driver and an *already-qualified* weighted
// point (a routine destination they've driven to enough times). A driver
// with no qualified points yet, or driving somewhere that simply isn't on
// the way to one, would otherwise never get a push no matter how directly
// ahead a hazard is -- see road-alerts-push-worker.js's runPushCheckOnce,
// which now falls back to this plain heading/bearing check (mirroring
// RoadAlerts.tsx's own fetchSignals: `onRouteIds.has(signal.id) ||
// isAhead(heading, bearing)`) for any signal route-matching didn't already
// catch.

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two points, in meters. */
function haversineDistanceMeters(a, b) {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from `a` to `b`, in degrees [0, 360), true north. */
function bearingDegrees(a, b) {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

function angularCrossTrack(user, point, target) {
  const angularDistanceToTarget = haversineDistanceMeters(user, target) / EARTH_RADIUS_METERS;
  const bearingToTarget = toRadians(bearingDegrees(user, target));
  const bearingToPoint = toRadians(bearingDegrees(user, point));
  return Math.asin(Math.sin(angularDistanceToTarget) * Math.sin(bearingToTarget - bearingToPoint));
}

function angularAlongTrack(user, point, target) {
  const angularDistanceToTarget = haversineDistanceMeters(user, target) / EARTH_RADIUS_METERS;
  const crossTrack = angularCrossTrack(user, point, target);
  const ratio = Math.cos(angularDistanceToTarget) / Math.cos(crossTrack);
  const magnitude = Math.acos(Math.min(1, Math.max(-1, ratio)));

  const bearingToTarget = toRadians(bearingDegrees(user, target));
  const bearingToPoint = toRadians(bearingDegrees(user, point));
  const isForward = Math.cos(bearingToTarget - bearingToPoint) >= 0;
  return isForward ? magnitude : -magnitude;
}

function crossTrackDistanceMeters(user, point, target) {
  return Math.abs(angularCrossTrack(user, point, target)) * EARTH_RADIUS_METERS;
}

function alongTrackDistanceMeters(user, point, target) {
  return angularAlongTrack(user, point, target) * EARTH_RADIUS_METERS;
}

const DEFAULT_MATCH_OPTIONS = {
  minWeight: 0,
  corridorMeters: 300,
  maxPointDistanceMeters: 10000,
};

function hazardBetweenUserAndPoint(user, point, target, corridorMeters = DEFAULT_MATCH_OPTIONS.corridorMeters) {
  const pathDistanceMeters = haversineDistanceMeters(user, point);
  if (pathDistanceMeters === 0) return false;
  if (crossTrackDistanceMeters(user, point, target) > corridorMeters) return false;
  const alongTrack = alongTrackDistanceMeters(user, point, target);
  return alongTrack >= 0 && alongTrack <= pathDistanceMeters;
}

/** Mirrors ui/shared/roadAlertsMatching.ts's findAlertsForWeightedPoints exactly -- see the module comment above. */
function findAlertsForWeightedPoints(user, weightedPoints, signals, options = {}) {
  const { minWeight, corridorMeters, maxPointDistanceMeters } = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const triggeredBySignalId = new Map();

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

/** Mirrors ui/shared/roadAlertsMatching.ts's shouldStronglyAlert exactly -- see the module comment above, including why `congestion` is excluded regardless of severity. */
function shouldStronglyAlert(severity, hazardCategory) {
  return (severity === 'serious' || severity === 'need_to_know') && hazardCategory !== 'congestion';
}

/** Mirrors ui/shared/geo.ts's isAhead exactly -- see the module comment above. */
function isAhead(headingDeg, bearingDeg, coneDeg = 90) {
  if (headingDeg === null || headingDeg === undefined || headingDeg < 0) return true;
  const diff = Math.abs(((bearingDeg - headingDeg + 540) % 360) - 180);
  return diff <= coneDeg / 2;
}

module.exports = {
  findAlertsForWeightedPoints,
  shouldStronglyAlert,
  hazardBetweenUserAndPoint,
  crossTrackDistanceMeters,
  alongTrackDistanceMeters,
  isAhead,
  bearingDegrees,
};
