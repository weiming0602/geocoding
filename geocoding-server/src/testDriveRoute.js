const { NotFoundError, OutOfRangeError } = require('./errors');
const { validateCoordinate, flatDistanceMeters } = require('./nextCrossStreet');
const { nearestTopologyNodeId, buildPathGeometry } = require('./roadReroute');

// Test-only: the street-following path a *simulated* drive replays as fake
// GPS fixes (see ui/shared/driveSimulation.ts and the Road Alerts sandbox),
// so Road Alerts can be exercised from a desk -- same reasoning as
// testRoadSignals.js's fake hazards. Gated behind ALLOW_TEST_ROAD_SIGNALS
// in server.js. Never offered as real navigation: same caveats as
// roadReroute.js -- directed by OSM one-way data where matched (else
// two-way), and no speed data.

// Straight-line cap on a simulated trip -- comfortably covers any drive
// worth sitting through at a desk, and keeps the bounding box below small.
const MAX_DRIVE_DISTANCE_METERS = 150000;
// How far beyond the start/end bounding box pgr_dijkstra may wander, in
// degrees (~8-11km in Maine). Restricting the edge set this way gave the
// identical Portland->Brunswick route as the full statewide graph in
// ~0.2s instead of ~3.3s; a route that genuinely needs a longer way around
// than this just comes back as a NotFoundError rather than a slow query.
const BBOX_MARGIN_DEGREES = 0.1;

/**
 * pgr_dijkstra's first argument is SQL text it EXECUTEs itself, so the
 * bbox numbers are interpolated directly -- safe only because every
 * value already passed validateCoordinate (real, range-checked numbers),
 * same rule as roadReroute.js's buildAvoidHazardEdgesSql.
 */
function buildBoundedEdgesSql(start, end) {
  const minLon = Math.min(start.longitude, end.longitude);
  const minLat = Math.min(start.latitude, end.latitude);
  const maxLon = Math.max(start.longitude, end.longitude);
  const maxLat = Math.max(start.latitude, end.latitude);
  return (
    'SELECT id, source, target, cost, reverse_cost FROM streets_routing_edges ' +
    `WHERE geom && ST_Expand(ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326), ${BBOX_MARGIN_DEGREES})`
  );
}

/**
 * Shortest street path from start to end as a GeoJSON LineString, plus
 * its length. Throws OutOfRangeError past MAX_DRIVE_DISTANCE_METERS,
 * NotFoundError if either end isn't near routable street data or no
 * connected path exists.
 */
async function getDriveRoute(db, { startLatitude, startLongitude, endLatitude, endLongitude }) {
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
    `SELECT seq, node, edge, agg_cost FROM pgr_dijkstra($1, $2::bigint, $3::bigint, true) ORDER BY seq`,
    [buildBoundedEdgesSql(start, end), startNode, endNode]
  );
  if (pathRows.length === 0) {
    throw new NotFoundError('no street route found between these points');
  }

  const usedEdgeIds = pathRows.filter((row) => row.edge !== -1).map((row) => row.edge);
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

  return {
    geometry: { type: 'LineString', coordinates: buildPathGeometry(pathRows, edgesById) },
    distanceMeters: pathRows[pathRows.length - 1].agg_cost,
  };
}

module.exports = { getDriveRoute, buildBoundedEdgesSql, MAX_DRIVE_DISTANCE_METERS, BBOX_MARGIN_DEGREES };
