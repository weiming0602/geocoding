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

function weightedPointsUrl(port, { email = TEST_EMAIL, serviceKey } = {}) {
  const params = new URLSearchParams();
  if (email !== undefined) params.set('email', email);
  if (serviceKey !== undefined) params.set('serviceKey', serviceKey);
  return `http://127.0.0.1:${port}/road-alerts/weighted-points?${params.toString()}`;
}

test('POST /road-alerts/weighted-points requires no env flag -- always on for a registered account', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, latitude: 43.9, longitude: -69.8 }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.point.latitude, 43.9);
      assert.equal(Number(body.point.weight), 1);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/weighted-points rejects an email with no Road Alerts account at all', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey: 'not-a-real-key', latitude: 43.9, longitude: -69.8 }),
      });
      assert.equal(response.status, 404);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/weighted-points rejects a registered email with the wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey: 'wrong-key', latitude: 43.9, longitude: -69.8 }),
      });
      assert.equal(response.status, 401);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/weighted-points with isEndpoint never creates a point', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          latitude: 43.9,
          longitude: -69.8,
          isEndpoint: true,
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.point, null);

      const getResponse = await fetch(weightedPointsUrl(port, { serviceKey }));
      const getBody = await getResponse.json();
      assert.equal(getBody.weightedPoints.length, 0);
    },
    { seedStreets: false }
  ));

test('GET /road-alerts/weighted-points returns previously recorded points', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      await fetch(`http://127.0.0.1:${port}/road-alerts/weighted-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, latitude: 43.9, longitude: -69.8 }),
      });

      const response = await fetch(weightedPointsUrl(port, { serviceKey }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.weightedPoints.length, 1);
      assert.equal(body.weightedPoints[0].latitude, 43.9);
    },
    { seedStreets: false }
  ));

test('GET /road-alerts/weighted-points requires a valid email format', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(weightedPointsUrl(port, { email: 'not-an-email', serviceKey: 'x' }));
      assert.equal(response.status, 400);
    },
    { seedStreets: false }
  ));
