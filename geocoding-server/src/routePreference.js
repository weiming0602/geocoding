const { metersPerDegree } = require('./interpolate');

// Weighted-point route preference for Road Alerts routes (detours in
// roadReroute.js, simulated drives in testDriveRoute.js). Weighted points
// are the streets a driver actually drives (weightedPoints.js), so a route
// along them is preferred over a slightly shorter unfamiliar one.
//
// Weighted points are sparse -- one ping roughly every 3 minutes of
// driving, so they sit ~1-4 km apart along a routine, not on every street
// -- which rules out simply discounting the streets right next to each
// point (that saves a few dozen meters, never enough to change a route).
// Instead, alongside the ordinary shortest routes, routes are computed
// THROUGH weighted points -- one per relevant point, plus one through all
// of them in the order a driver heading from start to end would reach
// them -- and candidates are ranked by how many weighted points they pass
// (meeting as many of the driver's usual roads as possible comes first),
// then by length x a weight-based discount, then by length. A route more
// than MAX_LENGTH_RATIO x the shortest candidate never outranks a shorter
// one, however many points it passes.

// A route counts as passing a weighted point if it comes within this of it.
const PASS_RADIUS_METERS = 30;
// Score multiplier for a route passing a weighted point: MIN_FACTOR for
// the driver's heaviest point, rising toward MAX_FACTOR for their lightest.
const MIN_FACTOR = 0.3;
const MAX_FACTOR = 0.7;
// A weighted point is worth routing through only if going via it is at
// most this many times the direct distance -- roughly "on the way",
// matching the 1 / MIN_FACTOR break-even above.
const MAX_VIA_DETOUR_RATIO = 3;
// Ignore a weighted point this close to the start or end -- it IS where
// the trip starts/ends, not a road to prefer on the way. Deliberately
// small: a point a few hundred meters from the target is still a street
// the driver would rather approach along (an earlier 500 m version wrongly
// dropped those).
const MIN_ENDPOINT_DISTANCE_METERS = 50;
// A route longer than this many times the shortest candidate never
// outranks a shorter one, however many weighted points it passes --
// matching the 1 / MIN_FACTOR discount break-even.
const MAX_LENGTH_RATIO = 3;
// At most this many points (nearest the start first) in the one route
// through all of them.
const MAX_POINTS_IN_ONE_ROUTE = 8;
// How many weighted points (heaviest first) to try routing through.
const MAX_VIA_CANDIDATES = 3;

function flatDistanceMeters(a, b) {
  const [mPerDegLon, mPerDegLat] = metersPerDegree((a.latitude + b.latitude) / 2);
  return Math.hypot((b.longitude - a.longitude) * mPerDegLon, (b.latitude - a.latitude) * mPerDegLat);
}

/** Distance in meters from `point` to a GeoJSON [lon, lat] polyline (flat-plane, fine at street scale). */
function distanceToPolylineMeters(point, coordinates) {
  if (coordinates.length === 0) return Infinity;
  const [mPerDegLon, mPerDegLat] = metersPerDegree(point.latitude);
  const toLocal = ([lon, lat]) => [(lon - point.longitude) * mPerDegLon, (lat - point.latitude) * mPerDegLat];
  let best = Infinity;
  for (let i = 0; i < coordinates.length; i++) {
    const [ax, ay] = toLocal(coordinates[i]);
    if (i === coordinates.length - 1) {
      best = Math.min(best, Math.hypot(ax, ay));
      break;
    }
    const [bx, by] = toLocal(coordinates[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** MIN_FACTOR for the heaviest of the driver's points, up to MAX_FACTOR for a weightless one. */
function weightFactor(weight, maxWeight) {
  if (!(maxWeight > 0)) return MIN_FACTOR;
  const share = Math.max(0, Math.min(1, weight / maxWeight));
  return MIN_FACTOR + (MAX_FACTOR - MIN_FACTOR) * (1 - share);
}

/** `points` minus those within MIN_ENDPOINT_DISTANCE_METERS of `start` or `end`. */
function pointsAwayFromEnds(points, start, end) {
  return points.filter(
    (p) =>
      typeof p.latitude === 'number' &&
      typeof p.longitude === 'number' &&
      flatDistanceMeters(start, p) >= MIN_ENDPOINT_DISTANCE_METERS &&
      flatDistanceMeters(p, end) >= MIN_ENDPOINT_DISTANCE_METERS
  );
}

/**
 * Weighted points worth routing through between `start` and `end`:
 * roughly on the way (MAX_VIA_DETOUR_RATIO), not at either end, heaviest
 * first, at most MAX_VIA_CANDIDATES.
 */
function relevantWeightedPoints(points, start, end) {
  const direct = flatDistanceMeters(start, end);
  return pointsAwayFromEnds(points, start, end)
    .filter((p) => flatDistanceMeters(start, p) + flatDistanceMeters(p, end) <= MAX_VIA_DETOUR_RATIO * direct)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, MAX_VIA_CANDIDATES);
}

/**
 * Relevant points (see relevantWeightedPoints, but up to
 * MAX_POINTS_IN_ONE_ROUTE) in the order a driver going start -> end would
 * reach them: by how far along the start -> end line each one projects.
 */
function pointsInTravelOrder(points, start, end) {
  const [mPerDegLon, mPerDegLat] = metersPerDegree((start.latitude + end.latitude) / 2);
  const ex = (end.longitude - start.longitude) * mPerDegLon;
  const ey = (end.latitude - start.latitude) * mPerDegLat;
  const along = (p) => (p.longitude - start.longitude) * mPerDegLon * ex + (p.latitude - start.latitude) * mPerDegLat * ey;
  const direct = flatDistanceMeters(start, end);
  return pointsAwayFromEnds(points, start, end)
    .filter((p) => flatDistanceMeters(start, p) + flatDistanceMeters(p, end) <= MAX_VIA_DETOUR_RATIO * direct)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, MAX_POINTS_IN_ONE_ROUTE)
    .sort((a, b) => along(a) - along(b));
}

/**
 * Which weighted points to route through, as candidate groups: each
 * relevant point on its own, plus (when there are 2+) all of them in
 * travel order -- the "meet as many usual roads as possible" route.
 */
function weightedViaGroups(points, start, end) {
  const singles = relevantWeightedPoints(points, start, end).map((p) => [p]);
  const ordered = pointsInTravelOrder(points, start, end);
  return ordered.length >= 2 ? [...singles, ordered] : singles;
}

/**
 * Orders candidate routes ({ geometry, distanceMeters, ... }) from
 * `start` to `end` by preference and returns the best `limit`, each with
 * `usesWeightedPoints` (passes at least one of `points` along the way)
 * and `weightedPointsPassed` (how many). Among routes no longer than
 * MAX_LENGTH_RATIO x the shortest: most weighted points passed first, then
 * distance x the best discount among them, then distance; longer routes
 * follow, shortest first. Points at either end don't count
 * (MIN_ENDPOINT_DISTANCE_METERS). Routes with identical geometry are kept
 * once.
 */
function rankRoutes(routes, allPoints, limit, start, end) {
  const points = pointsAwayFromEnds(allPoints, start, end);
  const maxWeight = Math.max(0, ...points.map((p) => p.weight ?? 0));
  const seen = new Set();
  const scored = [];
  for (const route of routes) {
    const signature = route.geometry.coordinates.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
    if (seen.has(signature)) continue;
    seen.add(signature);
    const passed = points.filter((p) => distanceToPolylineMeters(p, route.geometry.coordinates) <= PASS_RADIUS_METERS);
    const factor = Math.min(1, ...passed.map((p) => weightFactor(p.weight ?? 0, maxWeight)));
    scored.push({
      route: { ...route, usesWeightedPoints: passed.length > 0, weightedPointsPassed: passed.length },
      score: route.distanceMeters * factor,
    });
  }
  const shortest = Math.min(...scored.map((entry) => entry.route.distanceMeters));
  const withinRatio = (entry) => entry.route.distanceMeters <= MAX_LENGTH_RATIO * shortest;
  scored.sort(
    (a, b) =>
      Number(withinRatio(b)) - Number(withinRatio(a)) ||
      (withinRatio(a) ? b.route.weightedPointsPassed - a.route.weightedPointsPassed || a.score - b.score : 0) ||
      a.route.distanceMeters - b.route.distanceMeters
  );
  return scored.slice(0, limit).map((entry) => entry.route);
}

// A weighted point further than this from any street isn't on a road we
// can route along (same idea as roadReroute.js's node-snap limit).
const MAX_POINT_TO_STREET_METERS = 300;

/**
 * Via vertices that make a route actually drive the street segment a
 * weighted point is on: both of that segment's end intersections, the one
 * nearer `from` first. (The nearest intersection alone isn't enough --
 * weighted points usually sit mid-street, and on a long rural segment the
 * nearest intersection can be far away and reachable without ever using
 * that street.) Returns [] if no street is within
 * MAX_POINT_TO_STREET_METERS.
 */
async function viaNodesForPoint(db, point, from) {
  const { rows } = await db.query(
    `SELECT source, target,
            ST_Distance(ST_StartPoint(geom)::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS source_dist,
            ST_Distance(ST_EndPoint(geom)::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS target_dist
     FROM streets_routing_edges
     WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $5)
     ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
     LIMIT 1`,
    [point.longitude, point.latitude, from.longitude, from.latitude, MAX_POINT_TO_STREET_METERS]
  );
  if (rows.length === 0) return [];
  const { source, target, source_dist: sourceDist, target_dist: targetDist } = rows[0];
  return sourceDist <= targetDist ? [source, target] : [target, source];
}

/**
 * pgr_dijkstraVia rows for start -> via... -> end over `edgesSql`, or []
 * if any leg is unreachable (strict). `directed` must match the caller's
 * other route queries. Rows have the same (node, edge) shape
 * buildPathGeometry expects; total length is the last row's
 * route_agg_cost.
 */
async function viaRouteRows(db, edgesSql, nodeIds, directed) {
  // Consecutive repeats (a via vertex that IS the start/end) would be a
  // zero-length leg; pgr_dijkstraVia needs distinct neighbors.
  nodeIds = nodeIds.filter((id, i) => i === 0 || String(id) !== String(nodeIds[i - 1]));
  if (nodeIds.length < 3) return [];
  const { rows } = await db.query(
    `SELECT seq, path_id, node, edge, route_agg_cost
     FROM pgr_dijkstraVia($1, $2::bigint[], directed => $3, strict => true)
     ORDER BY seq`,
    [edgesSql, nodeIds, directed]
  );
  return rows;
}

module.exports = {
  rankRoutes,
  relevantWeightedPoints,
  pointsInTravelOrder,
  weightedViaGroups,
  weightFactor,
  distanceToPolylineMeters,
  viaRouteRows,
  viaNodesForPoint,
  PASS_RADIUS_METERS,
  MIN_FACTOR,
  MAX_FACTOR,
  MAX_VIA_DETOUR_RATIO,
  MIN_ENDPOINT_DISTANCE_METERS,
  MAX_LENGTH_RATIO,
};
