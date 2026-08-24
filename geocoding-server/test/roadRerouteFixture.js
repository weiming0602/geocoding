// Minimal synthetic street network for roadReroute.test.js /
// roadRerouteEndpoint.test.js -- real Postgres/PostGIS/pgRouting tables
// (not the Python package; this seeds streets/streets_topology_nodes/
// streets_routing_edges directly via SQL, mirroring what
// routing_topology.py builds), so getRoadReroute's actual pgr_ksp query
// runs against something real rather than a mock.
//
// Layout (all in flat lon/lat degrees near the equator, where
// metersPerDegree(0) is exactly 111320 for both axes -- see
// interpolate.js -- so meters-based reasoning below is exact, not
// approximate):
//
//   N4 -------- N5        (top detour: N1-N4-N5-N3)
//  /                  \
// N1 ---- N2 ---- N3       (direct path, blocked by the hazard buffer)
//  \                  /
//   N6 -------- N7        (bottom detour: N1-N6-N7-N3)
//
// N3 sits exactly where getRoadReroute itself computes the rejoin point
// (REJOIN_DISTANCE_METERS past the hazard, along the driver-to-hazard
// bearing when no heading is given) -- not an arbitrary nearby point --
// so the nearest-node snap actually finds it.

const { bearingDegreesFlat, destinationPointFlat, REJOIN_DISTANCE_METERS } = require('../src/roadReroute');

const METERS_PER_DEGREE = 111320.0; // matches interpolate.js's metersPerDegree(0)

const DRIVER = { latitude: 0, longitude: 0 };
// 500m due east of the driver -- a real, distinct point, comfortably
// under MAX_HAZARD_DISTANCE_METERS.
const HAZARD = { latitude: 0, longitude: 500 / METERS_PER_DEGREE };

const driverToHazardBearing = bearingDegreesFlat(
  DRIVER.latitude,
  DRIVER.longitude,
  HAZARD.latitude,
  HAZARD.longitude
);
const REJOIN = destinationPointFlat(HAZARD.latitude, HAZARD.longitude, driverToHazardBearing, REJOIN_DISTANCE_METERS);

const LAT_OFFSET = 200 / METERS_PER_DEGREE; // ~200m north/south -- the two detour rows

const NODES = {
  N1: DRIVER,
  N2: HAZARD,
  N3: REJOIN,
  N4: { latitude: LAT_OFFSET, longitude: DRIVER.longitude },
  N5: { latitude: LAT_OFFSET, longitude: REJOIN.longitude },
  N6: { latitude: -LAT_OFFSET, longitude: DRIVER.longitude },
  N7: { latitude: -LAT_OFFSET, longitude: REJOIN.longitude },
};

// (tlid, from-node, to-node)
const EDGES = [
  ['E1', 'N1', 'N2'], // direct, first half -- excluded by the hazard buffer
  ['E2', 'N2', 'N3'], // direct, second half -- excluded by the hazard buffer
  ['E3', 'N1', 'N4'], // top detour
  ['E4', 'N4', 'N5'],
  ['E5', 'N5', 'N3'],
  ['E6', 'N1', 'N6'], // bottom detour
  ['E7', 'N6', 'N7'],
  ['E8', 'N7', 'N3'],
];

/**
 * Seeds `pool` (already CREATE EXTENSION postgis + pgrouting'd, see
 * createTestDatabase's options) with the network above, plus a real
 * streets_topology_nodes table and streets_routing_edges view built the
 * same way routing_topology.py builds them. Returns { tlid: streets.id }
 * so tests can assert on specific edges if needed.
 */
async function seedRoadRerouteFixture(pool) {
  await pool.query(`
    CREATE TABLE streets (
      id BIGSERIAL PRIMARY KEY,
      tlid TEXT,
      geometry TEXT,
      geom geometry(Geometry, 4326),
      tnidf TEXT,
      tnidt TEXT
    )
  `);

  const edgeIds = {};
  for (const [tlid, fromNode, toNode] of EDGES) {
    const from = NODES[fromNode];
    const to = NODES[toNode];
    const wkt = `LINESTRING (${from.longitude} ${from.latitude}, ${to.longitude} ${to.latitude})`;
    const { rows } = await pool.query(
      `INSERT INTO streets (tlid, geometry, geom, tnidf, tnidt)
       VALUES ($1, $2, ST_GeomFromText($2, 4326), $3, $4)
       RETURNING id`,
      [tlid, wkt, fromNode, toNode]
    );
    edgeIds[tlid] = rows[0].id;
  }

  await pool.query(`
    CREATE TABLE streets_topology_nodes (
      id SERIAL PRIMARY KEY,
      tnid TEXT UNIQUE NOT NULL,
      geom geometry(Point, 4326) NOT NULL
    )
  `);
  await pool.query(`
    INSERT INTO streets_topology_nodes (tnid, geom)
    SELECT tnidf, ST_StartPoint(geom) FROM streets
    UNION
    SELECT tnidt, ST_EndPoint(geom) FROM streets
    ON CONFLICT (tnid) DO NOTHING
  `);
  await pool.query(`
    CREATE OR REPLACE VIEW streets_routing_edges AS
    SELECT s.id AS id, nf.id AS source, nt.id AS target,
           ST_Length(s.geom::geography) AS cost, s.geom AS geom
    FROM streets s
    JOIN streets_topology_nodes nf ON nf.tnid = s.tnidf
    JOIN streets_topology_nodes nt ON nt.tnid = s.tnidt
  `);

  return edgeIds;
}

module.exports = { seedRoadRerouteFixture, DRIVER, HAZARD, REJOIN, NODES, EDGES };
