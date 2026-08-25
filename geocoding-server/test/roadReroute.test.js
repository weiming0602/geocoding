const test = require('node:test');
const assert = require('node:assert/strict');

const { OutOfRangeError, NotFoundError } = require('../src/errors');
const { getRoadReroute, buildPathGeometry, MAX_HAZARD_DISTANCE_METERS } = require('../src/roadReroute');
const { createTestDatabase } = require('./helpers');
const { seedRoadRerouteFixture, DRIVER, HAZARD, REJOIN } = require('./roadRerouteFixture');

// buildPathGeometry is pure/synchronous -- no database needed to exercise
// its forward/backward-edge and shared-endpoint-dedup logic directly.
test('buildPathGeometry uses an edge as-is when the path departs from its source', () => {
  const edgesById = new Map([[1, { source: 10, target: 20, coordinates: [[0, 0], [1, 1]] }]]);
  const geometry = buildPathGeometry(
    [
      { node: 10, edge: 1 },
      { node: 20, edge: -1 },
    ],
    edgesById
  );
  assert.deepEqual(geometry, [[0, 0], [1, 1]]);
});

test('buildPathGeometry reverses an edge when the path departs from its target', () => {
  const edgesById = new Map([[1, { source: 10, target: 20, coordinates: [[0, 0], [1, 1]] }]]);
  const geometry = buildPathGeometry(
    [
      { node: 20, edge: 1 },
      { node: 10, edge: -1 },
    ],
    edgesById
  );
  assert.deepEqual(geometry, [[1, 1], [0, 0]]);
});

test('buildPathGeometry drops the duplicate point shared between two consecutive edges', () => {
  const edgesById = new Map([
    [1, { source: 10, target: 20, coordinates: [[0, 0], [1, 1]] }],
    [2, { source: 20, target: 30, coordinates: [[1, 1], [2, 2]] }],
  ]);
  const geometry = buildPathGeometry(
    [
      { node: 10, edge: 1 },
      { node: 20, edge: 2 },
      { node: 30, edge: -1 },
    ],
    edgesById
  );
  assert.deepEqual(geometry, [[0, 0], [1, 1], [2, 2]]);
});

async function makeFixtureDb() {
  const { pool, drop } = await createTestDatabase({ postgis: true, pgrouting: true });
  await seedRoadRerouteFixture(pool);
  pool.close = drop;
  return pool;
}

test('getRoadReroute returns 2 distinct detours around the hazard, neither using the blocked direct path', async () => {
  const db = await makeFixtureDb();
  const result = await getRoadReroute(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
  });

  assert.equal(result.options.length, 2);
  for (const option of result.options) {
    assert.equal(option.geometry.type, 'LineString');
    assert.equal(option.durationSeconds, null);
    // The direct (blocked) path is exactly 2000m (500m to the hazard +
    // 1500m rejoin); either detour is ~2445m (two ~222m north/south legs
    // plus the ~2000m crossing) -- comfortably above 2000m proves this
    // option took a detour, not the excluded direct edges.
    assert.ok(option.distanceMeters > 2200 && option.distanceMeters < 2600, option.distanceMeters);

    const coords = option.geometry.coordinates;
    assert.ok(Math.abs(coords[0][0] - DRIVER.longitude) < 0.0001 && Math.abs(coords[0][1] - DRIVER.latitude) < 0.0001);
    const last = coords[coords.length - 1];
    assert.ok(Math.abs(last[0] - REJOIN.longitude) < 0.0001 && Math.abs(last[1] - REJOIN.latitude) < 0.0001);
  }

  assert.ok(Math.abs(result.rejoinPoint.latitude - REJOIN.latitude) < 1e-9);
  assert.ok(Math.abs(result.rejoinPoint.longitude - REJOIN.longitude) < 1e-9);

  await db.close();
});

test('getRoadReroute throws OutOfRangeError when the hazard is farther than the max range', async () => {
  const db = await makeFixtureDb();
  await assert.rejects(
    () =>
      getRoadReroute(db, {
        driverLatitude: DRIVER.latitude,
        driverLongitude: DRIVER.longitude,
        hazardLatitude: DRIVER.latitude + 1, // ~111km north -- well beyond the max
        hazardLongitude: DRIVER.longitude,
      }),
    OutOfRangeError
  );
  assert.ok(MAX_HAZARD_DISTANCE_METERS > 0);
  await db.close();
});

test('getRoadReroute throws NotFoundError when the driver is not near any routable street data', async () => {
  const db = await makeFixtureDb();
  // ~4000m south of the hazard -- within MAX_HAZARD_DISTANCE_METERS of it
  // (so the distance guard doesn't fire first), but nowhere near any of
  // the fixture's seeded nodes (all within ~2000m of the origin band).
  await assert.rejects(
    () =>
      getRoadReroute(db, {
        driverLatitude: HAZARD.latitude - 4000 / 111320,
        driverLongitude: HAZARD.longitude,
        hazardLatitude: HAZARD.latitude,
        hazardLongitude: HAZARD.longitude,
      }),
    NotFoundError
  );
  await db.close();
});
