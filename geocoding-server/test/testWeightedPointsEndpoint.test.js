const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

const TEST_EMAIL = 'alice@example.com';

/** Registers a Road Alerts account against the given usersDb and returns its service key. */
async function registerTestAccount(usersDb, email = TEST_EMAIL) {
  const { registerAccount } = require('../src/roadAlertsAccounts');
  const account = await registerAccount(usersDb, email);
  return account.service_key;
}

// Same pattern as allowTestEmptyServiceKey.test.js's withFlagEnabled --
// allowsTestWeightedPoints() (server.js) reads process.env at request
// time, so setting it inside withTestServer's callback (after its
// internal fresh require, which clears this var -- see helpers.js) is
// enough to affect the next fetch().
function withFlagEnabled(callback) {
  return async (ctx) => {
    const saved = process.env.ALLOW_TEST_WEIGHTED_POINTS;
    process.env.ALLOW_TEST_WEIGHTED_POINTS = 'true';
    try {
      await callback(ctx);
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_WEIGHTED_POINTS = saved;
      else delete process.env.ALLOW_TEST_WEIGHTED_POINTS;
    }
  };
}

function weightedPointsUrl(port, { email = TEST_EMAIL, serviceKey } = {}) {
  const params = new URLSearchParams();
  if (email !== undefined) params.set('email', email);
  if (serviceKey !== undefined) params.set('serviceKey', serviceKey);
  return `http://127.0.0.1:${port}/road-alerts/test/weighted-points?${params.toString()}`;
}

test('POST/GET/DELETE /road-alerts/test/weighted-points all 404 when the flag is off', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const postResponse = await fetch(`http://127.0.0.1:${port}/road-alerts/test/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, latitude: 43.9, longitude: -69.8, weight: 0.9 }),
      });
      assert.equal(postResponse.status, 404);

      const getResponse = await fetch(weightedPointsUrl(port, { serviceKey }));
      assert.equal(getResponse.status, 404);

      const deleteResponse = await fetch(weightedPointsUrl(port, { serviceKey }), { method: 'DELETE' });
      assert.equal(deleteResponse.status, 404);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/test/weighted-points adds a point, GET returns it, when the flag is on', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const postResponse = await fetch(`http://127.0.0.1:${port}/road-alerts/test/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          latitude: 43.9106,
          longitude: -69.8148,
          weight: 0.9,
          label: 'Route 1 near Bath',
        }),
      });
      assert.equal(postResponse.status, 200);
      const created = await postResponse.json();
      assert.equal(created.label, 'Route 1 near Bath');

      const getResponse = await fetch(weightedPointsUrl(port, { serviceKey }));
      assert.equal(getResponse.status, 200);
      const body = await getResponse.json();
      assert.equal(body.weightedPoints.length, 1);
      assert.equal(body.weightedPoints[0].latitude, 43.9106);
    }),
    { seedStreets: false }
  ));

test('DELETE /road-alerts/test/weighted-points clears every point for the account', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const { addTestWeightedPoint } = require('../src/testWeightedPoints');
      await addTestWeightedPoint(usersDb, TEST_EMAIL, { latitude: 43.9, longitude: -69.8, weight: 0.9 });
      await addTestWeightedPoint(usersDb, TEST_EMAIL, { latitude: 44.0, longitude: -69.7, weight: 0.7 });

      const deleteResponse = await fetch(weightedPointsUrl(port, { serviceKey }), { method: 'DELETE' });
      assert.equal(deleteResponse.status, 200);
      assert.equal((await deleteResponse.json()).deleted, 2);

      const getResponse = await fetch(weightedPointsUrl(port, { serviceKey }));
      assert.equal((await getResponse.json()).weightedPoints.length, 0);
    }),
    { seedStreets: false }
  ));

test('GET /road-alerts/test/weighted-points rejects a wrong service key even when the flag is on', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      await registerTestAccount(usersDb);

      const response = await fetch(weightedPointsUrl(port, { serviceKey: 'mk_wrong' }));
      assert.equal(response.status, 401);
    }),
    { seedStreets: false }
  ));

test('POST /road-alerts/test/weighted-points rejects a non-numeric latitude even when the flag is on', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/test/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, latitude: 'nope', longitude: -69.8, weight: 0.9 }),
      });
      assert.equal(response.status, 400);
    }),
    { seedStreets: false }
  ));
