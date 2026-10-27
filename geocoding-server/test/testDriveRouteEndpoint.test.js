const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');
const { seedRoadRerouteFixture, NODES } = require('./roadRerouteFixture');

const TEST_EMAIL = 'alice@example.com';

async function registerTestAccount(usersDb, email = TEST_EMAIL) {
  const { registerAccount } = require('../src/roadAlertsAccounts');
  const account = await registerAccount(usersDb, email);
  return account.service_key;
}

// Same pattern as testRoadSignalsEndpoint.test.js -- the drive route is
// gated by the same ALLOW_TEST_ROAD_SIGNALS flag as the fake hazards.
function withFlagEnabled(callback) {
  return async (ctx) => {
    const saved = process.env.ALLOW_TEST_ROAD_SIGNALS;
    process.env.ALLOW_TEST_ROAD_SIGNALS = 'true';
    try {
      await callback(ctx);
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_ROAD_SIGNALS = saved;
      else delete process.env.ALLOW_TEST_ROAD_SIGNALS;
    }
  };
}

function driveRouteUrl(port, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  return `http://127.0.0.1:${port}/road-alerts/test/drive-route?${qs.toString()}`;
}

// Reuses roadReroute's synthetic network (see roadRerouteFixture.js):
// with no hazard to avoid, the shortest N1 -> N3 path is the direct
// N1-N2-N3 row (500m + 1500m), not either 200m-offset detour.
const FIXTURE_OPTIONS = {
  seedStreets: false,
  geoOptions: { postgis: true, pgrouting: true },
  geoSeed: seedRoadRerouteFixture,
};

const BASE_PARAMS = {
  email: TEST_EMAIL,
  startLatitude: NODES.N1.latitude,
  startLongitude: NODES.N1.longitude,
  endLatitude: NODES.N3.latitude,
  endLongitude: NODES.N3.longitude,
};

test('GET /road-alerts/test/drive-route 404s when the flag is off', () =>
  withTestServer(async ({ port, usersDb }) => {
    const serviceKey = await registerTestAccount(usersDb);
    const response = await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey }));
    assert.equal(response.status, 404);
  }, FIXTURE_OPTIONS));

test('GET /road-alerts/test/drive-route returns the shortest street path from start to end', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const response = await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey }));
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.geometry.type, 'LineString');
      const coords = body.geometry.coordinates;
      // ST_AsGeoJSON rounds to 9 decimal places, hence the tolerance.
      const near = (a, b) => Math.abs(a - b) < 1e-8;
      assert.ok(near(coords[0][0], NODES.N1.longitude) && near(coords[0][1], NODES.N1.latitude));
      const last = coords[coords.length - 1];
      assert.ok(near(last[0], NODES.N3.longitude) && near(last[1], NODES.N3.latitude));
      // Straight along the equator -- every point on the direct row.
      for (const [, lat] of coords) assert.ok(near(lat, 0));
      assert.ok(Math.abs(body.distanceMeters - 2000) < 5, `expected ~2000m, got ${body.distanceMeters}`);
    }),
    FIXTURE_OPTIONS
  ));

test('GET /road-alerts/test/drive-route 404s when an end point is nowhere near a street', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const response = await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey, endLatitude: 0.2 }));
      assert.equal(response.status, 404);
    }),
    FIXTURE_OPTIONS
  ));

test('GET /road-alerts/test/drive-route rejects a trip beyond the max distance with 422', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const response = await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey, endLatitude: 5 }));
      assert.equal(response.status, 422);
    }),
    FIXTURE_OPTIONS
  ));

test('GET /road-alerts/test/drive-route rejects a missing coordinate with 400 and a wrong key with 401', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const missing = await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey, endLongitude: undefined }));
      assert.equal(missing.status, 400);
      const wrongKey = await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey: 'mk_wrong' }));
      assert.equal(wrongKey.status, 401);
    }),
    FIXTURE_OPTIONS
  ));

// Weighted points (routine streets): a test weighted point on the north
// detour row makes the ~2397 m route through it preferred over the
// ~2000 m direct row -- the preference wins unless a route is ~3x longer.
function withBothFlags(callback) {
  return async (ctx) => {
    const saved = process.env.ALLOW_TEST_WEIGHTED_POINTS;
    process.env.ALLOW_TEST_WEIGHTED_POINTS = 'true';
    try {
      await withFlagEnabled(callback)(ctx);
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_WEIGHTED_POINTS = saved;
      else delete process.env.ALLOW_TEST_WEIGHTED_POINTS;
    }
  };
}

test('GET /road-alerts/test/drive-route prefers a route along the account\'s weighted points', () =>
  withTestServer(
    withBothFlags(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const { addTestWeightedPoint } = require('../src/testWeightedPoints');
      await addTestWeightedPoint(usersDb, TEST_EMAIL, { latitude: NODES.N4.latitude, longitude: NODES.N5.longitude / 2, weight: 5 });

      const body = await (await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey }))).json();
      assert.equal(body.usesWeightedPoints, true);
      // 200 m north + ~2000 m across + 200 m back south.
      assert.ok(Math.abs(body.distanceMeters - 2397) < 10, `expected the ~2397m north row, got ${body.distanceMeters}`);
      assert.ok(body.geometry.coordinates.some(([, lat]) => lat > 0.001), 'expected the route to run along the north row');
    }),
    FIXTURE_OPTIONS
  ));

test('GET /road-alerts/test/drive-route takes the shortest route when the account has no weighted points', () =>
  withTestServer(
    withBothFlags(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const body = await (await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey }))).json();
      assert.equal(body.usesWeightedPoints, false);
      assert.ok(Math.abs(body.distanceMeters - 2000) < 5);
    }),
    FIXTURE_OPTIONS
  ));

// "Meet as many usual roads as possible": two light weighted points on the
// north detour row against one much heavier point on the south row. The
// north row meets two of the driver's points, so it wins despite the
// heavier single point -- and over the ~2 km direct row.
test('GET /road-alerts/test/drive-route prefers the route meeting the most weighted points', () =>
  withTestServer(
    withBothFlags(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const { addTestWeightedPoint } = require('../src/testWeightedPoints');
      const north = NODES.N4.latitude;
      await addTestWeightedPoint(usersDb, TEST_EMAIL, { latitude: north, longitude: NODES.N5.longitude * 0.3, weight: 1 });
      await addTestWeightedPoint(usersDb, TEST_EMAIL, { latitude: north, longitude: NODES.N5.longitude * 0.7, weight: 1 });
      await addTestWeightedPoint(usersDb, TEST_EMAIL, { latitude: NODES.N6.latitude, longitude: NODES.N7.longitude / 2, weight: 20 });

      const body = await (await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey }))).json();
      assert.equal(body.weightedPointsPassed, 2);
      assert.ok(body.geometry.coordinates.some(([, lat]) => lat > 0.001), 'expected the north row');
      assert.ok(!body.geometry.coordinates.some(([, lat]) => lat < -0.001), 'expected not the south row');
    }),
    FIXTURE_OPTIONS
  ));

// The sandbox report: a weighted point ~350 m before the destination
// still decides which way the route arrives.
test('GET /road-alerts/test/drive-route arrives along a weighted point near the destination', () =>
  withTestServer(
    withBothFlags(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const { addTestWeightedPoint } = require('../src/testWeightedPoints');
      const nearEnd = { latitude: NODES.N4.latitude, longitude: NODES.N5.longitude - 300 / 111320, weight: 5 };
      await addTestWeightedPoint(usersDb, TEST_EMAIL, nearEnd);

      const body = await (await fetch(driveRouteUrl(port, { ...BASE_PARAMS, serviceKey }))).json();
      assert.equal(body.usesWeightedPoints, true);
      assert.ok(body.geometry.coordinates.some(([, lat]) => lat > 0.001), 'expected the north row');
    }),
    FIXTURE_OPTIONS
  ));
