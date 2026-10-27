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
// may wander, in degrees (~3-5 km). pgRouting loads every edge its SQL
// returns on each call: the whole Maine/NH graph took ~8.6 s per detour.
// A driver/rejoin point further than this from the nearest real topology
// node isn't "near a mapped street" -- it's an unmapped area (a
// MULTILINESTRING edge routing_topology.py skips, a state we haven't
// backfilled, or a genuinely off-road position), and snapping to
// whatever node happens to be nearest -- however far -- would silently
// produce a nonsensical route rather than an honest "no data here yet".
const MAX_NODE_SNAP_DISTANCE_METERS = 300;
// A driver within this of a street node is on it -- see startNodeAhead.
const ON_NODE_METERS = 10;
// How many distinct route options to offer -- the "couple of choices"
// this feature exists to offer, same target_count ORS was asked for
// previously.
const ROUTE_OPTION_COUNT = 3;
// Alternatives come from the penalty method (see alternativeRoutes), not
// pgr_ksp: in a city grid the k shortest paths are near-copies of each
// other -- a real Portland detour's three options shared 95-99% of their
// streets and differed by 2-30 m. Each search after the first makes the
// streets already used this many times as expensive...
const ALTERNATIVE_PENALTY = 3;
// ...and a result only counts as a real alternative if at most this share
// of its length is on streets an earlier option already uses,
const MAX_SHARED_FRACTION = 0.6;
// and it's at most this many times the shortest option.
const MAX_ALTERNATIVE_RATIO = 2;
// Searches to try (the first is the plain shortest route).
const ALTERNATIVE_ATTEMPTS = 5;
// Whether route searches honor one-way restrictions -- every route query
// (alternativeRoutes, and viaRouteRows for weighted-point routes) uses
// this, so they always agree.
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
  const node = await nearestTopologyNode(db, latitude, longitude);
  return node ? node.id : null;
}

/**
 * The street node to start a driver's route from: the nearest one ahead
 * of them (within 90 degrees of `heading`), or the nearest overall when
 * the heading is unknown or nothing lies ahead. Plain nearest can be
 * behind the car -- the route then began by driving back to it, a U-turn
 * mid-street. A node the driver is practically on counts either way.
 */
async function startNodeAhead(db, latitude, longitude, heading) {
  if (typeof heading !== 'number' || Number.isNaN(heading) || heading < 0) {
    return nearestTopologyNodeId(db, latitude, longitude);
  }
  const { rows } = await db.query(
    `SELECT id, ST_Y(geom) AS latitude, ST_X(geom) AS longitude FROM streets_topology_nodes
     WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
     LIMIT 10`,
    [longitude, latitude, MAX_NODE_SNAP_DISTANCE_METERS]
  );
  if (rows.length === 0) return null;
  const ahead = rows.find((node) => {
    if (flatDistanceMeters(latitude, longitude, node.latitude, node.longitude) <= ON_NODE_METERS) return true;
    const bearing = bearingDegreesFlat(latitude, longitude, node.latitude, node.longitude);
    const difference = Math.abs(((bearing - heading + 540) % 360) - 180);
    return difference <= 90;
  });
  return (ahead ?? rows[0]).id;
}

/** Like nearestTopologyNodeId, but { id, latitude, longitude } (the node's own position) or null. */
async function nearestTopologyNode(db, latitude, longitude) {
  const { rows } = await db.query(
    `SELECT id, ST_Y(geom) AS latitude, ST_X(geom) AS longitude FROM streets_topology_nodes
     WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
     LIMIT 1`,
    [longitude, latitude, MAX_NODE_SNAP_DISTANCE_METERS]
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * pgr_dijkstra's first argument is a `text` SQL string it EXECUTEs itself, not
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
 * Up to `count` genuinely different routes from startNode to endNode over
 * `edgesSql` (the penalty method): the shortest, then repeated searches
 * with every street already used made ALTERNATIVE_PENALTY x as expensive,
 * keeping a result only if it shares at most MAX_SHARED_FRACTION of its
 * length with the options so far and is at most MAX_ALTERNATIVE_RATIO x
 * the shortest. Returns [{ rows, distanceMeters }] (rows: node/edge in
 * order, as buildPathGeometry expects; distances are real, unpenalized),
 * shortest first -- [] if endNode is unreachable.
 */
async function alternativeRoutes(db, edgesSql, startNode, endNode, count, directed) {
  const routes = [];
  const used = new Set(); // edge ids on any route found so far
  for (let attempt = 0; attempt < ALTERNATIVE_ATTEMPTS && routes.length < count; attempt += 1) {
    const penalized = [...used].map((id) => String(BigInt(id))).join(', ');
    // reverse_cost read via to_jsonb so this also works over edges SQL
    // without that column (before one-way data existed), where a missing
    // reverse_cost means two-way -- same convention as segmentForPoint.
    const sql =
      used.size === 0
        ? edgesSql
        : `SELECT id, source, target,
                  CASE WHEN id IN (${penalized}) AND cost >= 0 THEN cost * ${ALTERNATIVE_PENALTY} ELSE cost END AS cost,
                  CASE WHEN id IN (${penalized}) AND rc >= 0 THEN rc * ${ALTERNATIVE_PENALTY} ELSE rc END AS reverse_cost
           FROM (SELECT e.*, COALESCE((to_jsonb(e) ->> 'reverse_cost')::float8, e.cost) AS rc FROM (${edgesSql}) AS e) AS e`;
    const { rows } = await db.query(
      `SELECT node, edge, cost FROM pgr_dijkstra($1, $2::bigint, $3::bigint, directed => $4) ORDER BY path_seq`,
      [sql, startNode, endNode, directed]
    );
    if (rows.length === 0) break; // unreachable -- penalties never make it reachable
    // Real (unpenalized) length of each edge used.
    const lengths = rows
      .filter((row) => row.edge >= 0)
      .map((row) => ({ edge: row.edge, meters: used.has(row.edge) ? row.cost / ALTERNATIVE_PENALTY : row.cost }));
    const distanceMeters = lengths.reduce((sum, { meters }) => sum + meters, 0);
    const isAlternative =
      routes.length === 0 ||
      (distanceMeters <= MAX_ALTERNATIVE_RATIO * routes[0].distanceMeters &&
        routes.every((route) => {
          const shared = lengths.filter(({ edge }) => route.edges.has(edge)).reduce((sum, { meters }) => sum + meters, 0);
          return shared <= MAX_SHARED_FRACTION * distanceMeters;
        }));
    if (isAlternative) routes.push({ rows, distanceMeters, edges: new Set(lengths.map(({ edge }) => edge)) });
    for (const { edge } of lengths) used.add(edge);
  }
  return routes.map(({ rows, distanceMeters }) => ({ rows, distanceMeters }));
}

/**
 * Turns one route's's ordered (node, edge) rows into a single
 * GeoJSON LineString coordinate list. Each streets_routing_edges row's
 * own geometry runs from its `source` node to its `target` node --
 * exactly the direction the route traveled it only when the path departs
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
    if (!edge) continue; // shouldn't happen: every edge a route used came from streets_routing_edges
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
 * Finds 1-3 genuinely different driving routes from the driver's
 * position to a point past the hazard, avoiding a buffer around the
 * hazard itself -- entirely from our own streets/topology data via
 * pgRouting (alternativeRoutes), no external routing service. Throws OutOfRangeError if the
 * hazard is too far away to be a meaningful detour target, NotFoundError
 * if the driver/rejoin point isn't near any real routable street data
 * yet, or if no route around the hazard exists at all (a dead end/
 * disconnected area).
 *
 * With a destination (the driver's actual target -- today only a
 * simulated drive knows one), routes go all the way there instead of to
 * an estimated rejoin point; the response's rejoinPoint is then the
 * destination's street node and endsAtDestination is true.
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
  {
    driverLatitude,
    driverLongitude,
    driverHeading,
    hazardLatitude,
    hazardLongitude,
    destinationLatitude,
    destinationLongitude,
    weightedPoints = [],
  }
) {
  validateCoordinate(driverLatitude, driverLongitude, 'driver');
  validateCoordinate(hazardLatitude, hazardLongitude, 'hazard');
  const hasDestination = destinationLatitude !== undefined || destinationLongitude !== undefined;
  if (hasDestination) validateCoordinate(destinationLatitude, destinationLongitude, 'destination');

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
    startNodeAhead(db, driverLatitude, driverLongitude, driverHeading),
    hasDestination
      ? nearestTopologyNode(db, destinationLatitude, destinationLongitude).then((node) => (node ? [node] : []))
      : rejoinCandidates(db, hazardLatitude, hazardLongitude, bearing, estimate),
  ]);
  if (startNode === null) {
    throw new NotFoundError('no routable street data near this location yet');
  }
  if (candidates.length === 0) {
    throw new NotFoundError(
      hasDestination ? 'no routable street data near the destination' : 'no routable street data past this hazard to rejoin'
    );
  }

  let paths = [];
  let rejoinPoint = null;
  let rejoinNode = null;
  for (const candidate of candidates) {
    const edgesSql = buildAvoidHazardEdgesSql(hazardLatitude, hazardLongitude, [
      { latitude: driverLatitude, longitude: driverLongitude },
      { latitude: hazardLatitude, longitude: hazardLongitude },
      candidate,
    ]);
    paths = await alternativeRoutes(db, edgesSql, startNode, candidate.id, ROUTE_OPTION_COUNT, ROUTE_DIRECTED);
    if (paths.length > 0) {
      rejoinPoint = { latitude: candidate.latitude, longitude: candidate.longitude };
      rejoinNode = candidate;
      break;
    }
  }

  if (paths.length === 0) {
    throw new NotFoundError('no route found around this hazard');
  }

  // Candidate routes: genuinely different plain options (alternativeRoutes),
  // plus routes through the driver's weighted points (routine streets)
  // roughly on the way -- then all ranked together by rankRoutes, which
  // prefers passing weighted points unless a route is ~3x longer (see
  // routePreference.js).
  const driver = { latitude: driverLatitude, longitude: driverLongitude };
  const hazard = { latitude: hazardLatitude, longitude: hazardLongitude };
  // Weighted-point routes are a preference on top of the plain routes
  // above, never a reason to fail: if anything here breaks, log it and
  // still return detours without them.
  try {
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

  return { options, rejoinPoint, endsAtDestination: hasDestination };
}

module.exports = {
  getRoadReroute,
  nearestTopologyNodeId,
  nearestTopologyNode,
  startNodeAhead,
  bearingDegreesFlat,
  destinationPointFlat,
  buildPathGeometry,
  alternativeRoutes,
  REJOIN_DISTANCE_METERS,
  AVOID_RADIUS_METERS,
  MAX_HAZARD_DISTANCE_METERS,
  MAX_NODE_SNAP_DISTANCE_METERS,
};
