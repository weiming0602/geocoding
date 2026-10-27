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
// THROUGH weighted points -- one per relevant point, plus the best
// combination and order of them, chosen from real driving distances
// (one pgr_dijkstraCostMatrix query; see bestWeightedGroup) -- and
// candidates are ranked by how many weighted points they pass (meeting as
// many of the driver's usual roads as possible comes first), then by
// length x a weight-based discount, then by length. A route more than
// MAX_LENGTH_RATIO x the shortest candidate never outranks a shorter one,
// however many points it passes.

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
// At most this many weighted points (heaviest kept) are considered for the
// combined route -- every subset and order is tried, so this bounds the
// search (6 points, both directions of two-way streets: well under a
// second of plain arithmetic).
const MAX_POINTS_IN_ONE_ROUTE = 6;
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
 * Weighted points eligible for the combined route: relevant (roughly on
 * the way, not at either end), heaviest MAX_POINTS_IN_ONE_ROUTE kept.
 * Callers include these in the search area of their route queries.
 */
function groupCandidatePoints(points, start, end) {
  const direct = flatDistanceMeters(start, end);
  return pointsAwayFromEnds(points, start, end)
    .filter((p) => flatDistanceMeters(start, p) + flatDistanceMeters(p, end) <= MAX_VIA_DETOUR_RATIO * direct)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, MAX_POINTS_IN_ONE_ROUTE);
}

/**
 * Pure core of bestWeightedGroup: which weighted points to visit, in what
 * order and direction, judged by real driving distances.
 *
 * segments: [{ point, factor, length, orientations: [[entry, exit], ...] }]
 *   (a one-way street has one orientation, a two-way street both);
 * cost(a, b): driving distance between two intersections (Infinity if
 *   unreachable, 0 for a == b).
 *
 * Tries every subset and order (and orientation). Among combinations no
 * longer than MAX_LENGTH_RATIO x the direct cost(startNode, endNode):
 * most points first, then length x the best discount among them, then
 * length. Returns { points, nodes, length } or null.
 */
function chooseBestGroup({ segments, startNode, endNode, cost }) {
  const direct = cost(startNode, endNode);
  if (!Number.isFinite(direct)) return null;
  const limit = MAX_LENGTH_RATIO * direct;
  let best = null;
  const better = (a, b) =>
    !b ||
    a.points.length > b.points.length ||
    (a.points.length === b.points.length && (a.score < b.score || (a.score === b.score && a.length < b.length)));

  function visit(current, used, length, points, nodes, factor) {
    if (points.length > 0) {
      const total = length + cost(current, endNode);
      if (total <= limit) {
        const candidate = { points, nodes, length: total, score: total * factor };
        if (better(candidate, best)) best = candidate;
      }
    }
    segments.forEach((segment, i) => {
      if (used & (1 << i)) return;
      for (const [entry, exit] of segment.orientations) {
        const next = length + cost(current, entry) + segment.length;
        if (!(next <= limit)) continue; // also skips Infinity / NaN
        visit(exit, used | (1 << i), next, [...points, segment.point], [...nodes, entry, exit], Math.min(factor, segment.factor));
      }
    });
  }
  visit(startNode, 0, 0, [], [], 1);
  return best && { points: best.points, nodes: best.nodes, length: best.length };
}

// A weighted point further than this from any street isn't on a road we
// can route along (same idea as roadReroute.js's node-snap limit).
const MAX_POINT_TO_STREET_METERS = 300;

/**
 * The street segment a weighted point is on (nearest usable one within
 * MAX_POINT_TO_STREET_METERS), with the directions it may be driven:
 * { source, target, length, forward, backward, sourceDist, targetDist }
 * (distances from `from`), or null. `e.*` rather than naming reverse_cost:
 * before one-way data existed the edges view had no reverse_cost column,
 * and a missing one means two-way.
 */
async function segmentForPoint(db, point, from) {
  const { rows } = await db.query(
    `SELECT e.*,
            ST_Distance(ST_StartPoint(e.geom)::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS source_dist,
            ST_Distance(ST_EndPoint(e.geom)::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS target_dist
     FROM streets_routing_edges e
     WHERE ST_DWithin(e.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $5)
     ORDER BY e.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
     LIMIT 5`,
    [point.longitude, point.latitude, from.longitude, from.latitude, MAX_POINT_TO_STREET_METERS]
  );
  for (const row of rows) {
    const forward = row.cost >= 0;
    const backward = (row.reverse_cost ?? row.cost) >= 0;
    if (!forward && !backward) continue; // closed both ways -- try the next nearest
    return {
      source: row.source,
      target: row.target,
      length: forward ? row.cost : (row.reverse_cost ?? row.cost),
      forward,
      backward,
      sourceDist: row.source_dist,
      targetDist: row.target_dist,
    };
  }
  return null;
}

/**
 * The best combination of weighted points to route through between
 * startNode and endNode over `edgesSql` (which must cover
 * groupCandidatePoints(points, start, end)), by real driving distance --
 * see chooseBestGroup. One pgr_dijkstraCostMatrix query gives every
 * pairwise distance between the start, end and each point's street ends
 * (~0.2 s on real Maine data), so the network decides the order:
 * straight-line ordering zig-zagged when a point sat on a one-way
 * interstate carriageway only reachable from one side (a real Brunswick
 * -> Freeport trip came out at 43 km for 21). Returns { points, nodes }
 * (nodes = entry/exit pairs, in order) or null.
 */
async function bestWeightedGroup(db, edgesSql, points, start, end, startNode, endNode, directed) {
  const candidates = groupCandidatePoints(points, start, end);
  if (candidates.length === 0) return null;
  const maxWeight = Math.max(0, ...points.map((p) => p.weight ?? 0));
  const segments = [];
  for (const point of candidates) {
    const segment = await segmentForPoint(db, point, start);
    if (!segment) continue;
    const orientations = [];
    if (segment.forward) orientations.push([segment.source, segment.target]);
    if (segment.backward) orientations.push([segment.target, segment.source]);
    segments.push({ point, factor: weightFactor(point.weight ?? 0, maxWeight), length: segment.length, orientations });
  }
  if (segments.length === 0) return null;

  const nodeIds = [...new Set([startNode, endNode, ...segments.flatMap((s) => s.orientations.flat())].map(String))];
  const { rows } = await db.query(
    `SELECT start_vid, end_vid, agg_cost FROM pgr_dijkstraCostMatrix($1, $2::bigint[], directed => $3)`,
    [edgesSql, nodeIds, directed]
  );
  const matrix = new Map(rows.map((r) => [`${r.start_vid}>${r.end_vid}`, r.agg_cost]));
  const cost = (a, b) => (String(a) === String(b) ? 0 : (matrix.get(`${a}>${b}`) ?? Infinity));

  const best = chooseBestGroup({ segments, startNode, endNode, cost });
  return best && { points: best.points, nodes: best.nodes };
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

/**
 * Via vertices that make a route actually drive the street segment a
 * weighted point is on: both of that segment's end intersections, in the
 * order the segment may be driven. (The nearest intersection alone isn't
 * enough -- weighted points usually sit mid-street, and on a long rural
 * segment the nearest intersection can be far away and reachable without
 * ever using that street.) A one-way segment is entered at its legal
 * start -- ordering by proximity alone forced long loops to drive a
 * one-way street, e.g. 13.6 km instead of 5 km for a short Portland trip.
 * A two-way segment is entered from the end nearer `from`. Returns [] if
 * no usable street is within MAX_POINT_TO_STREET_METERS.
 */
async function viaNodesForPoint(db, point, from) {
  const segment = await segmentForPoint(db, point, from);
  if (!segment) return [];
  if (segment.forward && !segment.backward) return [segment.source, segment.target];
  if (segment.backward && !segment.forward) return [segment.target, segment.source];
  return segment.sourceDist <= segment.targetDist ? [segment.source, segment.target] : [segment.target, segment.source];
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
  groupCandidatePoints,
  chooseBestGroup,
  bestWeightedGroup,
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
