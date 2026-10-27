const { NotFoundError, OutOfRangeError } = require('./errors');
const { validateCoordinate, flatDistanceMeters } = require('./nextCrossStreet');
const { metersPerDegree } = require('./interpolate');
const {
  rankRoutes,
  relevantWeightedPoints,
  groupCandidatePoints,
  bestWeightedGroup,
  viaRouteRows,
  viaNodesForPoint,
} = require('./routePreference');

// 511 gives only a single point per hazard, never a real start/end span
// (see roadSignals.js) -- this is a deliberate approximation of "past
// it": far enough along the road to clear a typical incident, not so far
// it's a meaningfully different trip. Reflected back in the response's
// rejoinPoint so callers can tell the driver it's an estimate, not exact
// hazard-end data.
const REJOIN_DISTANCE_METERS = 1500;
// Radius of the avoid-area drawn around the hazard's own point -- wide
// enough to cover the incident itself plus queued traffic, not so wide
// it rules out a legitimately close parallel road.
const AVOID_RADIUS_METERS = 150;
// Beyond this, a "detour" isn't a real answer to a hazard this far
// away yet. Covers everything the Road Alerts page can alert on, so a
// hazard the driver has just been alerted about can always get a detour:
// its 10 km search is a bounding box (roadSignals.js's filterByBbox), not
// a circle, so its corners reach ~14.1 km. At 5 km (the previous limit)
// the button failed for most alerts.
const MAX_HAZARD_DISTANCE_METERS = 15000;
// Where the detour rejoins: a real intersection between these distances
// past the hazard, within REJOIN_MAX_ANGLE_DEG of the direction of
// travel, picked closest to the REJOIN_DISTANCE_METERS straight-line
// estimate. (Previously the estimate itself had to fall within
// MAX_NODE_SNAP_DISTANCE_METERS of an intersection, which failed in
// rural areas whenever it landed in open country.)
const REJOIN_MIN_METERS = 800;
const REJOIN_MAX_METERS = 2500;
const REJOIN_MAX_ANGLE_DEG = 60;
// Candidate rejoin intersections to try, in order, before giving up --
// the nearest one can be a dead end with no route to it.
const REJOIN_CANDIDATE_COUNT = 3;
// How far beyond the driver/hazard/rejoin bounding box the route search
// may wander, in degrees (~3-5 km). pgr_ksp loads every edge its SQL
// returns on each call: the whole Maine/NH graph took ~8.6 s per detour.
// A driver/rejoin point further than this from the nearest real topology
// node isn't "near a mapped street" -- it's an unmapped area (a
// MULTILINESTRING edge routing_topology.py skips, a state we haven't
// backfilled, or a genuinely off-road position), and snapping to
// whatever node happens to be nearest -- however far -- would silently
// produce a nonsensical route rather than an honest "no data here yet".
const MAX_NODE_SNAP_DISTANCE_METERS = 300;
// How many distinct route options to ask pgr_ksp for -- the "couple of
// choices" this feature exists to offer, same target_count ORS was
// asked for previously.
const ROUTE_OPTION_COUNT = 3;
// Whether route searches honor one-way restrictions -- every query below
// (pgr_ksp, and pgr_dijkstraVia for weighted-point routes) uses this, so
// they always agree.
const ROUTE_DIRECTED = true;
const BBOX_MARGIN_DEGREES = 0.05;

/**
 * Bearing from (lat1,lon1) to (lat2,lon2), in degrees [0, 360) clockwise
 * from north -- flat-plane approximation via metersPerDegree, same
 * approach as nextCrossStreet.js's flatDistanceMeters, not a separate
 * spherical trig implementation.
 */
function bearingDegreesFlat(lat1, lon1, lat2, lon2) {
  const [mPerDegLon, mPerDegLat] = metersPerDegree((lat1 + lat2) / 2);
  const dx = (lon2 - lon1) * mPerDegLon;
  const dy = (lat2 - lat1) * mPerDegLat;
  const degrees = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Destination point `distanceMeters` from (lat,lon) along `bearingDeg` -- flat-plane, inverse of bearingDegreesFlat. */
function destinationPointFlat(lat, lon, bearingDeg, distanceMeters) {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const dx = distanceMeters * Math.sin(bearingRad);
  const dy = distanceMeters * Math.cos(bearingRad);
  const [mPerDegLon, mPerDegLat] = metersPerDegree(lat);
  return { latitude: lat + dy / mPerDegLat, longitude: lon + dx / mPerDegLon };
}

/**
 * Nearest streets_topology_nodes id to (latitude, longitude), or null if
 * nothing real exists within MAX_NODE_SNAP_DISTANCE_METERS -- the GiST
 * KNN `<->` operator picks the candidate, ST_DWithin is what actually
 * bounds how far "nearest" is allowed to be.
 */
async function nearestTopologyNodeId(db, latitude, longitude) {
  const { rows } = await db.query(
    `SELECT id FROM streets_topology_nodes
     WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
     LIMIT 1`,
    [longitude, latitude, MAX_NODE_SNAP_DISTANCE_METERS]
  );
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * pgr_ksp's first argument is a `text` SQL string it EXECUTEs itself, not
 * a normal bound-parameter slot -- hazardLatitude/hazardLongitude are
 * substituted directly into it. Safe here specifically because both
 * values already passed validateCoordinate (real numbers, range-checked)
 * before this is ever called -- never build this kind of string from
 * anything that hasn't gone through that same validation first.
 */
function buildAvoidHazardEdgesSql(hazardLatitude, hazardLongitude, boundsPoints = []) {
  // Every bounds point is either a validated coordinate or a real
  // topology node's own coordinate from the database -- numbers, never
  // caller-supplied text -- so interpolating them is as safe as the
  // hazard coordinates above.
  let boundsClause = '';
  if (boundsPoints.length > 0) {
    const lats = boundsPoints.map((p) => p.latitude);
    const lons = boundsPoints.map((p) => p.longitude);
    boundsClause =
      ` AND geom && ST_Expand(ST_MakeEnvelope(${Math.min(...lons)}, ${Math.min(...lats)}, ` +
      `${Math.max(...lons)}, ${Math.max(...lats)}, 4326), ${BBOX_MARGIN_DEGREES})`;
  }
  return (
    'SELECT id, source, target, cost, reverse_cost FROM streets_routing_edges ' +
    'WHERE NOT ST_DWithin(geom::geography, ' +
    `ST_SetSRID(ST_MakePoint(${hazardLongitude}, ${hazardLatitude}), 4326)::geography, ${AVOID_RADIUS_METERS})` +
    boundsClause
  );
}

/**
 * Real intersections the detour could rejoin at: REJOIN_MIN_METERS to
 * REJOIN_MAX_METERS past the hazard, within REJOIN_MAX_ANGLE_DEG of
 * `bearing`, nearest to `estimate` first.
 */
async function rejoinCandidates(db, hazardLatitude, hazardLongitude, bearing, estimate) {
  const { rows } = await db.query(
    `WITH h AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
     SELECT n.id, ST_Y(n.geom) AS latitude, ST_X(n.geom) AS longitude
     FROM streets_topology_nodes n, h
     WHERE ST_DWithin(n.geom::geography, h.geom::geography, $3)
       AND NOT ST_DWithin(n.geom::geography, h.geom::geography, $4)
       AND abs(mod((degrees(ST_Azimuth(h.geom, n.geom)) - $5 + 540)::numeric, 360) - 180) <= $6
     ORDER BY n.geom <-> ST_SetSRID(ST_MakePoint($7, $8), 4326)
     LIMIT $9`,
    [
      hazardLongitude,
      hazardLatitude,
      REJOIN_MAX_METERS,
      REJOIN_MIN_METERS,
      bearing,
      REJOIN_MAX_ANGLE_DEG,
      estimate.longitude,
      estimate.latitude,
      REJOIN_CANDIDATE_COUNT,
    ]
  );
  return rows;
}

/**
 * Turns one pgr_ksp path's ordered (node, edge) rows into a single
 * GeoJSON LineString coordinate list. Each streets_routing_edges row's
 * own geometry runs from its `source` node to its `target` node --
 * exactly the direction pgr_ksp traveled it only when the path departs
 * from that edge's `source`; when the path instead departs from its
 * `target` (the edge traveled backward relative to how it's stored),
 * that segment's coordinates must be reversed before appending. Adjacent
 * segments share an endpoint -- the duplicate is dropped, not left in.
 */
function buildPathGeometry(pathRows, edgesById) {
  const coordinates = [];
  for (const row of pathRows) {
    if (row.edge === -1) continue; // final row: no outgoing edge, nothing to append
    const edge = edgesById.get(row.edge);
    if (!edge) continue; // shouldn't happen: every edge pgr_ksp used came from streets_routing_edges
    const segment = edge.coordinates.slice();
    if (edge.source !== row.node) segment.reverse();
    for (const point of segment) {
      const last = coordinates[coordinates.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      coordinates.push(point);
    }
  }
  return coordinates;
}

/**
 * Finds 1-2 alternate driving routes from the driver's position to an
 * estimated point past the hazard, avoiding a buffer around the hazard
 * itself -- entirely from our own streets/topology data via pgRouting's
 * pgr_ksp, no external routing service. Throws OutOfRangeError if the
 * hazard is too far away to be a meaningful detour target, NotFoundError
 * if the driver/rejoin point isn't near any real routable street data
 * yet, or if no route around the hazard exists at all (a dead end/
 * disconnected area).
 *
 * Directed: one-way streets are only traveled their legal way.
 * TIGER itself has no one-way data, so direction comes from
 * OpenStreetMap via streets_routing_edges' cost/reverse_cost (see
 * geocoding/osm_oneway.py); a street OSM couldn't be matched to stays
 * two-way. TIGER has no speed data either, so durationSeconds is always
 * null rather than a fabricated estimate. Both limitations are surfaced
 * to the driver in the UI, not hidden here.
 */
async function getRoadReroute(
  db,
  { driverLatitude, driverLongitude, driverHeading, hazardLatitude, hazardLongitude, weightedPoints = [] }
) {
  validateCoordinate(driverLatitude, driverLongitude, 'driver');
  validateCoordinate(hazardLatitude, hazardLongitude, 'hazard');

  const directDistance = flatDistanceMeters(driverLatitude, driverLongitude, hazardLatitude, hazardLongitude);
  if (directDistance > MAX_HAZARD_DISTANCE_METERS) {
    throw new OutOfRangeError(
      `hazard is ${Math.round(directDistance)}m away, beyond the ${MAX_HAZARD_DISTANCE_METERS}m range this feature covers`
    );
  }

  // Continue along the driver's own heading if known (the road's actual
  // direction of travel); otherwise assume the road keeps going the same
  // way it has been from the driver to the hazard.
  const bearing =
    typeof driverHeading === 'number' && !Number.isNaN(driverHeading) && driverHeading >= 0
      ? driverHeading
      : bearingDegreesFlat(driverLatitude, driverLongitude, hazardLatitude, hazardLongitude);
  const estimate = destinationPointFlat(hazardLatitude, hazardLongitude, bearing, REJOIN_DISTANCE_METERS);

  const [startNode, candidates] = await Promise.all([
    nearestTopologyNodeId(db, driverLatitude, driverLongitude),
    rejoinCandidates(db, hazardLatitude, hazardLongitude, bearing, estimate),
  ]);
  if (startNode === null) {
    throw new NotFoundError('no routable street data near this location yet');
  }
  if (candidates.length === 0) {
    throw new NotFoundError('no routable street data past this hazard to rejoin');
  }

  let pathRows = [];
  let rejoinPoint = null;
  let rejoinNode = null;
  for (const candidate of candidates) {
    const edgesSql = buildAvoidHazardEdgesSql(hazardLatitude, hazardLongitude, [
      { latitude: driverLatitude, longitude: driverLongitude },
      { latitude: hazardLatitude, longitude: hazardLongitude },
      candidate,
    ]);
    // pgr_ksp is overloaded (bigint vs. anyarray node-id arguments, among
    // others) -- pg sends $2/$3 without an explicit type OID, which
    // Postgres can't resolve against that overload set on its own, hence
    // the explicit ::bigint casts (confirmed necessary: omitting them
    // throws "function pgr_ksp(...) is not unique").
    ({ rows: pathRows } = await db.query(
      `SELECT path_id, path_seq, node, edge, agg_cost
       FROM pgr_ksp($1, $2::bigint, $3::bigint, ${ROUTE_OPTION_COUNT}, ${ROUTE_DIRECTED})
       ORDER BY path_id, path_seq`,
      [edgesSql, startNode, candidate.id]
    ));
    if (pathRows.length > 0) {
      rejoinPoint = { latitude: candidate.latitude, longitude: candidate.longitude };
      rejoinNode = candidate;
      break;
    }
  }

  const pathIds = [...new Set(pathRows.map((row) => row.path_id))];
  if (pathIds.length === 0) {
    throw new NotFoundError('no route found around this hazard');
  }

  // Candidate routes: pgr_ksp's shortest options, plus one through each
  // weighted point (the driver's routine streets) that's roughly on the
  // way -- then all ranked together by rankRoutes, which prefers a route
  // passing a weighted point unless it's ~3x longer (see routePreference.js).
  const paths = pathIds.map((pathId) => {
    const rows = pathRows.filter((row) => row.path_id === pathId);
    return { rows, distanceMeters: rows[rows.length - 1].agg_cost };
  });
  const driver = { latitude: driverLatitude, longitude: driverLongitude };
  const hazard = { latitude: hazardLatitude, longitude: hazardLongitude };
  // One route through each relevant point on its own...
  for (const point of relevantWeightedPoints(weightedPoints, driver, rejoinPoint)) {
    const viaNodes = await viaNodesForPoint(db, point, driver);
    if (viaNodes.length === 0) continue;
    const viaEdgesSql = buildAvoidHazardEdgesSql(hazardLatitude, hazardLongitude, [driver, hazard, rejoinNode, point]);
    const rows = await viaRouteRows(db, viaEdgesSql, [startNode, ...viaNodes, rejoinNode.id], ROUTE_DIRECTED);
    if (rows.length > 0) paths.push({ rows, distanceMeters: rows[rows.length - 1].route_agg_cost });
  }
  // ...and one through the best combination of them, by driving distance.
  const groupPoints = groupCandidatePoints(weightedPoints, driver, rejoinPoint);
  if (groupPoints.length >= 2) {
    const groupEdgesSql = buildAvoidHazardEdgesSql(hazardLatitude, hazardLongitude, [driver, hazard, rejoinNode, ...groupPoints]);
    const group = await bestWeightedGroup(
      db, groupEdgesSql, weightedPoints, driver, rejoinPoint, startNode, rejoinNode.id, ROUTE_DIRECTED
    );
    if (group && group.points.length >= 2) {
      const rows = await viaRouteRows(db, groupEdgesSql, [startNode, ...group.nodes, rejoinNode.id], ROUTE_DIRECTED);
      if (rows.length > 0) paths.push({ rows, distanceMeters: rows[rows.length - 1].route_agg_cost });
    }
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

  const options = rankRoutes(
    paths.map(({ rows, distanceMeters }) => ({
      geometry: { type: 'LineString', coordinates: buildPathGeometry(rows, edgesById) },
      distanceMeters,
      durationSeconds: null,
    })),
    weightedPoints,
    ROUTE_OPTION_COUNT,
    driver,
    rejoinPoint
  );

  return { options, rejoinPoint };
}

module.exports = {
  getRoadReroute,
  nearestTopologyNodeId,
  bearingDegreesFlat,
  destinationPointFlat,
  buildPathGeometry,
  REJOIN_DISTANCE_METERS,
  AVOID_RADIUS_METERS,
  MAX_HAZARD_DISTANCE_METERS,
  MAX_NODE_SNAP_DISTANCE_METERS,
};
