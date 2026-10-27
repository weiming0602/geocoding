const { NotFoundError, OutOfRangeError } = require('./errors');
const { validateCoordinate, flatDistanceMeters } = require('./nextCrossStreet');
const { nearestTopologyNodeId, buildPathGeometry } = require('./roadReroute');
const {
  rankRoutes,
  relevantWeightedPoints,
  groupCandidatePoints,
  bestWeightedGroup,
  viaRouteRows,
  viaNodesForPoint,
} = require('./routePreference');

// Test-only: the street-following path a *simulated* drive replays as fake
// GPS fixes (see ui/shared/driveSimulation.ts and the Road Alerts sandbox),
// so Road Alerts can be exercised from a desk -- same reasoning as
// testRoadSignals.js's fake hazards. Gated behind ALLOW_TEST_ROAD_SIGNALS
// in server.js. Never offered as real navigation: same TIGER caveats as
// roadReroute.js (no one-way data, no speeds -- every street is two-way).

// Straight-line cap on a simulated trip -- comfortably covers any drive
// worth sitting through at a desk, and keeps the bounding box below small.
const MAX_DRIVE_DISTANCE_METERS = 150000;
// How far beyond the start/end bounding box pgr_dijkstra may wander, in
// degrees (~8-11km in Maine). Restricting the edge set this way gave the
// identical Portland->Brunswick route as the full statewide graph in
// ~0.2s instead of ~3.3s; a route that genuinely needs a longer way around
// than this just comes back as a NotFoundError rather than a slow query.
const BBOX_MARGIN_DEGREES = 0.1;
// Same role as roadReroute.js's ROUTE_DIRECTED: every route query here
// (pgr_dijkstra, and pgr_dijkstraVia for weighted-point routes) uses it.
const ROUTE_DIRECTED = false;

/**
 * pgr_dijkstra's first argument is SQL text it EXECUTEs itself, so the
 * bbox numbers are interpolated directly -- safe only because every
 * value already passed validateCoordinate (real, range-checked numbers),
 * same rule as roadReroute.js's buildAvoidHazardEdgesSql.
 */
function buildBoundedEdgesSql(start, end, extraPoints = []) {
  const points = [start, end, ...extraPoints];
  const minLon = Math.min(...points.map((p) => p.longitude));
  const minLat = Math.min(...points.map((p) => p.latitude));
  const maxLon = Math.max(...points.map((p) => p.longitude));
  const maxLat = Math.max(...points.map((p) => p.latitude));
  return (
    'SELECT id, source, target, cost FROM streets_routing_edges ' +
    `WHERE geom && ST_Expand(ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326), ${BBOX_MARGIN_DEGREES})`
  );
}

/**
 * Street path from start to end as a GeoJSON LineString, plus its length
 * -- the shortest one, unless a route along the driver's weighted points
 * (routine streets) is preferred by routePreference.js's ranking, in
 * which case `usesWeightedPoints` is true. Throws OutOfRangeError past MAX_DRIVE_DISTANCE_METERS,
 * NotFoundError if either end isn't near routable street data or no
 * connected path exists.
 */
async function getDriveRoute(db, { startLatitude, startLongitude, endLatitude, endLongitude, weightedPoints = [] }) {
  validateCoordinate(startLatitude, startLongitude, 'start');
  validateCoordinate(endLatitude, endLongitude, 'end');
  const start = { latitude: startLatitude, longitude: startLongitude };
  const end = { latitude: endLatitude, longitude: endLongitude };

  const directDistance = flatDistanceMeters(startLatitude, startLongitude, endLatitude, endLongitude);
  if (directDistance > MAX_DRIVE_DISTANCE_METERS) {
    throw new OutOfRangeError(
      `trip is ${Math.round(directDistance)}m in a straight line, beyond the ${MAX_DRIVE_DISTANCE_METERS}m a simulated drive covers`
    );
  }

  const [startNode, endNode] = await Promise.all([
    nearestTopologyNodeId(db, startLatitude, startLongitude),
    nearestTopologyNodeId(db, endLatitude, endLongitude),
  ]);
  if (startNode === null || endNode === null) {
    throw new NotFoundError('no routable street data near the start or end point');
  }
  if (startNode === endNode) {
    throw new NotFoundError('start and end snap to the same street node -- pick points further apart');
  }

  // Same explicit ::bigint casts as roadReroute.js's pgr_ksp call --
  // pgr_dijkstra is overloaded the same way.
  const { rows: pathRows } = await db.query(
    `SELECT seq, node, edge, agg_cost FROM pgr_dijkstra($1, $2::bigint, $3::bigint, ${ROUTE_DIRECTED}) ORDER BY seq`,
    [buildBoundedEdgesSql(start, end), startNode, endNode]
  );
  if (pathRows.length === 0) {
    throw new NotFoundError('no street route found between these points');
  }

  const paths = [{ rows: pathRows, distanceMeters: pathRows[pathRows.length - 1].agg_cost }];
  // Weighted-point routes are a preference on top of the plain routes
  // above, never a reason to fail: if anything here breaks, log it and
  // still return the simulated drive without them.
  try {
    // One route through each relevant point on its own...
    for (const point of relevantWeightedPoints(weightedPoints, start, end)) {
      const viaNodes = await viaNodesForPoint(db, point, start);
      if (viaNodes.length === 0) continue;
      const rows = await viaRouteRows(db, buildBoundedEdgesSql(start, end, [point]), [startNode, ...viaNodes, endNode], ROUTE_DIRECTED);
      if (rows.length > 0) paths.push({ rows, distanceMeters: rows[rows.length - 1].route_agg_cost });
    }
    // ...and one through the best combination of them, by driving distance.
    const groupPoints = groupCandidatePoints(weightedPoints, start, end);
    if (groupPoints.length >= 2) {
      const groupEdgesSql = buildBoundedEdgesSql(start, end, groupPoints);
      const group = await bestWeightedGroup(db, groupEdgesSql, weightedPoints, start, end, startNode, endNode, ROUTE_DIRECTED);
      if (group && group.points.length >= 2) {
        const rows = await viaRouteRows(db, groupEdgesSql, [startNode, ...group.nodes, endNode], ROUTE_DIRECTED);
        if (rows.length > 0) paths.push({ rows, distanceMeters: rows[rows.length - 1].route_agg_cost });
      }
    }
  } catch (err) {
    console.error('Weighted-point routes failed; using the plain routes only:', err);
  }

  const usedEdgeIds = [...new Set(paths.flatMap(({ rows }) => rows.filter((row) => row.edge >= 0).map((row) => row.edge)))];
  const { rows: edgeRows } = await db.query(
    `SELECT id, source, target, ST_AsGeoJSON(geom) AS geojson FROM streets_routing_edges WHERE id = ANY($1)`,
    [usedEdgeIds]
  );
  const edgesById = new Map(
    edgeRows.map((row) => [
      row.id,
      { source: row.source, target: row.target, coordinates: JSON.parse(row.geojson).coordinates },
    ])
  );

  const [best] = rankRoutes(
    paths.map(({ rows, distanceMeters }) => ({
      geometry: { type: 'LineString', coordinates: buildPathGeometry(rows, edgesById) },
      distanceMeters,
    })),
    weightedPoints,
    1,
    start,
    end
  );
  return best;
}

module.exports = { getDriveRoute, buildBoundedEdgesSql, MAX_DRIVE_DISTANCE_METERS, BBOX_MARGIN_DEGREES };
