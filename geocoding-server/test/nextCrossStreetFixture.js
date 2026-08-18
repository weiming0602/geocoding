// Minimal synthetic streets geometry for nextCrossStreet.test.js /
// nextCrossStreetEndpoint.test.js -- the real fixture in helpers.js
// (seedFixtureStreets) has no controllable "one street crossing another
// partway along a straight path" shape to assert exact distances
// against, so this builds its own tiny `streets` table instead, with
// just the columns findCandidates() actually queries.
//
// Geometry (all plain flat lon/lat degrees, no PostGIS needed):
//   MAIN_ST: vertical line (-70.000, 43.000) -> (-70.000, 43.010) -- the
//     hazard's own road.
//   DRIVER: (43.002, -70.000) -- on Main St.
//   HAZARD: (43.008, -70.000), roadway 'Main St' -- also on Main St,
//     ~668m north of the driver.
//   ELM_ST: horizontal line crossing Main St at lat 43.004 -- exactly
//     between driver and hazard on the direct line, so it passes the
//     "between" check (fromDriver ~223m + toHazard ~445m == the direct
//     ~668m) and is the expected winner.
//   OAK_ST: horizontal line crossing Main St at lat 43.000 -- south of
//     the driver (behind them, not toward the hazard), so its
//     fromDriver+toHazard sum (~1113m) exceeds the 1.3x tolerance
//     ceiling (~868m) and must never be returned.

const CREATE_STREETS_TABLE_SQL = `
CREATE TABLE streets (
  id BIGSERIAL PRIMARY KEY,
  fullname TEXT,
  geometry TEXT,
  minx DOUBLE PRECISION,
  miny DOUBLE PRECISION,
  maxx DOUBLE PRECISION,
  maxy DOUBLE PRECISION
);
`;

const DRIVER = { latitude: 43.002, longitude: -70.0 };
const HAZARD = { latitude: 43.008, longitude: -70.0, roadway: 'Main St' };

const ROWS = [
  { fullname: 'Main St', geometry: 'LINESTRING (-70.000 43.000, -70.000 43.010)' },
  { fullname: 'Elm St', geometry: 'LINESTRING (-70.010 43.004, -69.990 43.004)' },
  { fullname: 'Oak St', geometry: 'LINESTRING (-70.010 43.000, -69.990 43.000)' },
];

function bboxOf(wkt) {
  const coords = wkt
    .replace(/^LINESTRING\s*\(/, '')
    .replace(/\)$/, '')
    .split(',')
    .map((pair) => pair.trim().split(/\s+/).map(Number));
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

async function seedNextCrossStreetFixture(pool) {
  await pool.query(CREATE_STREETS_TABLE_SQL);
  for (const row of ROWS) {
    const [minx, miny, maxx, maxy] = bboxOf(row.geometry);
    await pool.query(
      `INSERT INTO streets (fullname, geometry, minx, miny, maxx, maxy) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.fullname, row.geometry, minx, miny, maxx, maxy]
    );
  }
}

module.exports = { seedNextCrossStreetFixture, DRIVER, HAZARD };
