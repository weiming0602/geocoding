const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');
const { seedRoadRerouteFixture, DRIVER, HAZARD } = require('./roadRerouteFixture');

const TEST_EMAIL = 'alice@example.com';

/** Registers a Road Alerts account against the given usersDb and returns its service key. */
async function registerTestAccount(usersDb, email = TEST_EMAIL) {
  const { registerAccount } = require('../src/roadAlertsAccounts');
  const account = await registerAccount(usersDb, email);
  return account.service_key;
}

function rerouteUrl(port, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  return `http://127.0.0.1:${port}/road-signals/reroute?${qs.toString()}`;
}

const BASE_PARAMS = {
  email: TEST_EMAIL,
  driverLatitude: DRIVER.latitude,
  driverLongitude: DRIVER.longitude,
  hazardLatitude: HAZARD.latitude,
  hazardLongitude: HAZARD.longitude,
};

// The fixture needs a real PostGIS+pgRouting-backed database seeded
// *before* the server starts (its own `db` is read-only-enforced --
// see createReadOnlyPool -- so it can't run the CREATE EXTENSION/TABLE
// statements itself); geoOptions/geoSeed handle that, see
// withTestServer's own doc comment.
const FIXTURE_OPTIONS = {
  seedStreets: false,
  geoOptions: { postgis: true, pgrouting: true },
  geoSeed: seedRoadRerouteFixture,
};

test(
  'GET /road-signals/reroute returns route options for a registered account',
  () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const response = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey }));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.options.length, 2);
        for (const option of body.options) {
          assert.equal(option.durationSeconds, null);
          assert.ok(option.distanceMeters > 0);
        }
        assert.ok(typeof body.rejoinPoint.latitude === 'number');
        assert.ok(typeof body.rejoinPoint.longitude === 'number');
      },
      FIXTURE_OPTIONS
    )
);

test('GET /road-signals/reroute returns 404 when nothing routable is near the driver', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      // ~4000m south of the hazard -- within range of the hazard itself,
      // but nowhere near any of the fixture's seeded nodes.
      const response = await fetch(
        rerouteUrl(port, {
          ...BASE_PARAMS,
          serviceKey,
          driverLatitude: HAZARD.latitude - 4000 / 111320,
          driverLongitude: HAZARD.longitude,
        })
      );
      assert.equal(response.status, 404);
      assert.match((await response.json()).error, /routable/);
    },
    FIXTURE_OPTIONS
  )
);

test('GET /road-signals/reroute rejects a missing hazard coordinate with 400', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const response = await fetch(
        rerouteUrl(port, {
          email: TEST_EMAIL,
          serviceKey,
          driverLatitude: DRIVER.latitude,
          driverLongitude: DRIVER.longitude,
        })
      );
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /hazard/);
    },
    { seedStreets: false }
  )
);

test('GET /road-signals/reroute rejects a missing email or serviceKey with 400', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const noEmail = await fetch(rerouteUrl(port, { ...BASE_PARAMS, email: undefined, serviceKey }));
      assert.equal(noEmail.status, 400);
      assert.match((await noEmail.json()).error, /email/);

      const noKey = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey: undefined }));
      assert.equal(noKey.status, 400);
      assert.match((await noKey.json()).error, /serviceKey/);
    },
    { seedStreets: false }
  )
);

test('GET /road-signals/reroute returns 404 for an unregistered email', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(
        rerouteUrl(port, { ...BASE_PARAMS, email: 'nobody@example.com', serviceKey: 'mk_whatever' })
      );
      assert.equal(response.status, 404);
    },
    { seedStreets: false }
  )
);

test('GET /road-signals/reroute returns 401 for a registered email with the wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerTestAccount(usersDb);
      const response = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey: 'mk_wrong' }));
      assert.equal(response.status, 401);
    },
    { seedStreets: false }
  )
);

test('GET /road-signals/reroute returns 422 when the hazard is farther than the max range', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const response = await fetch(
        rerouteUrl(port, {
          ...BASE_PARAMS,
          serviceKey,
          hazardLatitude: DRIVER.latitude + 1, // ~111km north -- well beyond the max
          hazardLongitude: DRIVER.longitude,
        })
      );
      assert.equal(response.status, 422);
    },
    { seedStreets: false }
  )
);
