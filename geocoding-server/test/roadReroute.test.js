const test = require('node:test');
const assert = require('node:assert/strict');

const { OutOfRangeError, NotFoundError } = require('../src/errors');
const { getRoadReroute, buildPathGeometry, MAX_HAZARD_DISTANCE_METERS } = require('../src/roadReroute');
const { createTestDatabase } = require('./helpers');
const { seedRoadRerouteFixture, setOneway, DRIVER, HAZARD, REJOIN, NODES } = require('./roadRerouteFixture');

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

// One-way streets (geocoding/osm_oneway.py's street_oneway): E4 is the
// top detour's long crossing, drawn N4 -> N5 (west -> east, the way the
// driver needs to go). Marked one-way against that (east -> west only),
// the top detour is illegal and must never be offered -- only the bottom
// one is left.
test('getRoadReroute never offers a detour that travels a one-way street the wrong way', async () => {
  const db = await makeFixtureDb();
  await setOneway(db, { E4: -1 });
  const result = await getRoadReroute(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
  });

  assert.equal(result.options.length, 1);
  // The bottom detour runs ~200m south of the direct row; the top one north.
  assert.ok(result.options[0].geometry.coordinates.every(([, lat]) => lat <= 1e-9), 'expected only the bottom (southern) detour');
  await db.close();
});

test('getRoadReroute throws NotFoundError when every way around is one-way against the driver', async () => {
  const db = await makeFixtureDb();
  await setOneway(db, { E4: -1, E7: -1 });
  await assert.rejects(
    () =>
      getRoadReroute(db, {
        driverLatitude: DRIVER.latitude,
        driverLongitude: DRIVER.longitude,
        hazardLatitude: HAZARD.latitude,
        hazardLongitude: HAZARD.longitude,
      }),
    NotFoundError
  );
  await db.close();
});

// Heading 60° (north-east) puts the straight-line rejoin estimate ~1500 m
// NE of the hazard -- ~585 m from the nearest fixture intersection (N5),
// beyond MAX_NODE_SNAP_DISTANCE_METERS. The old code required the estimate
// itself to snap, so this threw NotFoundError (the rural "open country"
// failure). Now a real intersection past the hazard in the direction of
// travel is chosen instead -- N5, the nearest to the estimate.
test('getRoadReroute rejoins at a real intersection past the hazard when the estimate lands off-street', async () => {
  const db = await makeFixtureDb();
  const result = await getRoadReroute(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    driverHeading: 60,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
  });
  assert.ok(result.options.length >= 1);
  const n5 = NODES.N5;
  assert.ok(Math.abs(result.rejoinPoint.latitude - n5.latitude) < 1e-9 && Math.abs(result.rejoinPoint.longitude - n5.longitude) < 1e-9);
  const last = result.options[0].geometry.coordinates.at(-1);
  assert.ok(Math.abs(last[0] - n5.longitude) < 1e-6 && Math.abs(last[1] - n5.latitude) < 1e-6);
  await db.close();
});

test('getRoadReroute throws NotFoundError when nothing lies past the hazard in the direction of travel', async () => {
  const db = await makeFixtureDb();
  // Heading due south: no fixture intersection lies 0.8-2.5 km south (±60°) of the hazard.
  await assert.rejects(
    () =>
      getRoadReroute(db, {
        driverLatitude: DRIVER.latitude,
        driverLongitude: DRIVER.longitude,
        driverHeading: 180,
        hazardLatitude: HAZARD.latitude,
        hazardLongitude: HAZARD.longitude,
      }),
    /past this hazard/
  );
  await db.close();
});

// The fixture's two detours are the same length, so with no preference
// either could come first. A weighted point (a routine street) on one of
// them must put that one first, flagged -- whichever side it's on.
for (const [side, latitude] of [['north (top)', NODES.N4.latitude], ['south (bottom)', NODES.N6.latitude]]) {
  test(`getRoadReroute lists the detour through a weighted point first -- ${side}`, async () => {
    const db = await makeFixtureDb();
    const routinePoint = { latitude, longitude: NODES.N5.longitude / 2, weight: 5 };
    const result = await getRoadReroute(db, {
      driverLatitude: DRIVER.latitude,
      driverLongitude: DRIVER.longitude,
      hazardLatitude: HAZARD.latitude,
      hazardLongitude: HAZARD.longitude,
      weightedPoints: [routinePoint],
    });
    const [first, ...rest] = result.options;
    assert.equal(first.usesWeightedPoints, true);
    assert.equal(first.weightedPointsPassed, 1);
    assert.ok(first.geometry.coordinates.some(([, lat]) => Math.abs(lat - latitude) < 1e-9), 'first option should run along that row');
    assert.ok(rest.every((option) => option.usesWeightedPoints === false));
    await db.close();
  });
}

// From a real Portland report: a weighted point on the hazard's own
// street, whose segment the avoid circle cuts off from everything else.
// The route through it is impossible -- the detours must still come back
// (pgr_dijkstraVia crashed on that unreachable leg, failing every detour
// request with a 500).
test('getRoadReroute still returns detours when a weighted point sits on the blocked street past the hazard', async () => {
  const db = await makeFixtureDb();
  const onBlockedStreet = { latitude: 0, longitude: HAZARD.longitude + 300 / 111320, weight: 5 };
  const result = await getRoadReroute(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
    weightedPoints: [onBlockedStreet],
  });
  assert.equal(result.options.length, 2);
  assert.ok(result.options.every((option) => option.distanceMeters > 2200));
  await db.close();
});

test('getRoadReroute falls back to the plain detours if weighted-point routing fails', async () => {
  const db = await makeFixtureDb();
  const failing = {
    query: (text, params) => {
      if (/FROM streets_routing_edges e\s+WHERE ST_DWithin/.test(text)) return Promise.reject(new Error('boom'));
      return db.query(text, params);
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await getRoadReroute(failing, {
      driverLatitude: DRIVER.latitude,
      driverLongitude: DRIVER.longitude,
      hazardLatitude: HAZARD.latitude,
      hazardLongitude: HAZARD.longitude,
      weightedPoints: [{ latitude: NODES.N4.latitude, longitude: NODES.N5.longitude / 2, weight: 5 }],
    });
    assert.equal(result.options.length, 2);
  } finally {
    console.error = originalError;
    await db.close();
  }
});
