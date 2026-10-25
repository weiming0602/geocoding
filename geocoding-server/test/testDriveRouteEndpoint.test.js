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
