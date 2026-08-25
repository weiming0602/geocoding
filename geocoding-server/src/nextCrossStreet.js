const { findCandidates, closestPointOnLine } = require('./reverseGeocode');
const { parseLinestring, metersPerDegree } = require('./interpolate');
const { ValidationError, NotFoundError, OutOfRangeError } = require('./errors');

// Beyond this, "turn off here" isn't actionable yet -- also bounds the
// search radius below.
const MAX_HAZARD_DISTANCE_METERS = 2000;
// Slack for road curvature in the "is this candidate roughly between the
// driver and the hazard" triangle-inequality check -- a straight-line
// approximation, not a real routed distance, so some allowance for a
// candidate street being a little off the direct line is needed.
const BETWEEN_TOLERANCE_FACTOR = 1.3;
// Margin added to the derived search radius for street width / the
// bbox-vs-ellipse approximation (findCandidates' bbox is a square, not a
// circle, and the "between" check is itself an ellipse, not a circle).
const SEARCH_PAD_METERS = 150;
const MIN_SEARCH_RADIUS_METERS = 200;

function validateCoordinate(latitude, longitude, label) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError(`${label} latitude must be a number`);
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError(`${label} longitude must be a number`);
  }
  if (latitude < -90 || latitude > 90) {
    throw new ValidationError(`${label} latitude must be between -90 and 90`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new ValidationError(`${label} longitude must be between -180 and 180`);
  }
}

/**
 * Flat-plane distance in meters -- same hand-rolled approach as
 * reverseGeocode.js's closestPointOnLine (metersPerDegree at the pair's
 * midpoint latitude), not a separate haversine implementation, so this
 * stays consistent with the rest of this codebase's geometry math.
 */
function flatDistanceMeters(lat1, lon1, lat2, lon2) {
  const [mPerDegLon, mPerDegLat] = metersPerDegree((lat1 + lat2) / 2);
  return Math.hypot((lon2 - lon1) * mPerDegLon, (lat2 - lat1) * mPerDegLat);
}

/**
 * Finds the nearest street a driver could turn onto to get off the
 * hazard's road before reaching it -- a proximity approximation using
 * the existing `streets` table (no PostGIS spatial functions, no real
 * routing/topology: `streets` has none, see nextCrossStreet's design
 * notes in docs/ROAD_ALERTS_DESIGN.md-adjacent planning). A candidate
 * street counts as "between" the driver and the hazard when the path
 * driver -> (closest point on that street) -> hazard isn't much longer
 * than the direct driver -> hazard distance (BETWEEN_TOLERANCE_FACTOR
 * slack for curvature) -- not proof of a real intersection, since no
 * topology exists to check that. Among qualifying candidates, the one
 * closest to the driver wins: the next reachable turn, not the one
 * closest to the hazard.
 */
async function findNextCrossStreet(db, { driverLatitude, driverLongitude, hazardLatitude, hazardLongitude, hazardRoadway }) {
  validateCoordinate(driverLatitude, driverLongitude, 'driver');
  validateCoordinate(hazardLatitude, hazardLongitude, 'hazard');

  const directDistance = flatDistanceMeters(driverLatitude, driverLongitude, hazardLatitude, hazardLongitude);
  if (directDistance > MAX_HAZARD_DISTANCE_METERS) {
    throw new OutOfRangeError(
      `hazard is ${Math.round(directDistance)}m away, beyond the ${MAX_HAZARD_DISTANCE_METERS}m range this feature covers`
    );
  }

  const midLatitude = (driverLatitude + hazardLatitude) / 2;
  const midLongitude = (driverLongitude + hazardLongitude) / 2;
  // Every "between" candidate lies within an ellipse with driver/hazard
  // as foci and semi-major axis (directDistance * TOLERANCE) / 2 -- every
  // point on/inside that ellipse is within that same distance of the
  // ellipse's center (the midpoint), so a single bbox search of that
  // radius (+ pad) at the midpoint is provably sufficient. No expanding-
  // radius loop needed, unlike reverseGeocode.js's open-ended search.
  const searchRadius = Math.max(
    MIN_SEARCH_RADIUS_METERS,
    (directDistance * BETWEEN_TOLERANCE_FACTOR) / 2 + SEARCH_PAD_METERS
  );

  const candidates = await findCandidates(db, midLatitude, midLongitude, searchRadius);
  if (candidates.length === 0) {
    throw new NotFoundError('no candidate streets found between the driver and the hazard');
  }

  const excludeUpper =
    typeof hazardRoadway === 'string' && hazardRoadway.trim() ? hazardRoadway.trim().toUpperCase() : null;

  let best = null;
  for (const row of candidates) {
    // Same UPPER(fullname) case-insensitive convention as geocode.js/
    // schema.py's matching index -- otherwise the hazard's own road
    // trivially "wins" (distance from the driver to their own road is
    // ~0). Done here in JS rather than as a new SQL param on
    // findCandidates, which is shared with reverseGeocode.js.
    if (excludeUpper && row.fullname && row.fullname.trim().toUpperCase() === excludeUpper) continue;

    let points;
    try {
      points = parseLinestring(row.geometry);
    } catch {
      continue; // e.g. a MULTILINESTRING, same skip as reverseGeocode.js
    }
    if (points.length < 2) continue;

    const fromDriver = closestPointOnLine(points, driverLongitude, driverLatitude);
    const toHazard = flatDistanceMeters(fromDriver.matchedLat, fromDriver.matchedLon, hazardLatitude, hazardLongitude);
    const isBetween = fromDriver.distance + toHazard <= directDistance * BETWEEN_TOLERANCE_FACTOR;
    if (!isBetween) continue;

    if (!best || fromDriver.distance < best.fromDriver.distance) {
      best = { row, fromDriver };
    }
  }
  if (!best) {
    throw new NotFoundError('no street found between the driver and the hazard');
  }

  return {
    fullname: best.row.fullname,
    distanceFromDriverMeters: Math.round(best.fromDriver.distance),
    matchedCoordinates: { latitude: best.fromDriver.matchedLat, longitude: best.fromDriver.matchedLon },
  };
}

module.exports = { findNextCrossStreet, flatDistanceMeters, validateCoordinate, MAX_HAZARD_DISTANCE_METERS };
