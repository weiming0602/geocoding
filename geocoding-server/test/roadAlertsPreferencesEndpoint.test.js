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

test('GET /road-alerts/preferences returns false by default', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(
        `http://127.0.0.1:${port}/road-alerts/preferences?email=${TEST_EMAIL}&serviceKey=${serviceKey}`
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.digestOptIn, false);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/preferences opts an account in and out', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const optIn = await fetch(`http://127.0.0.1:${port}/road-alerts/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, digestOptIn: true }),
      });
      assert.equal(optIn.status, 200);
      assert.equal((await optIn.json()).digestOptIn, true);

      const getAfterOptIn = await fetch(
        `http://127.0.0.1:${port}/road-alerts/preferences?email=${TEST_EMAIL}&serviceKey=${serviceKey}`
      );
      assert.equal((await getAfterOptIn.json()).digestOptIn, true);

      const optOut = await fetch(`http://127.0.0.1:${port}/road-alerts/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, digestOptIn: false }),
      });
      assert.equal((await optOut.json()).digestOptIn, false);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/preferences rejects a non-boolean digestOptIn', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, digestOptIn: 'yes' }),
      });

      assert.equal(response.status, 400);
    },
    { seedStreets: false }
  ));

test('GET and POST /road-alerts/preferences reject a wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerTestAccount(usersDb);

      const get = await fetch(
        `http://127.0.0.1:${port}/road-alerts/preferences?email=${TEST_EMAIL}&serviceKey=mk_wrong`
      );
      assert.equal(get.status, 401);

      const post = await fetch(`http://127.0.0.1:${port}/road-alerts/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey: 'mk_wrong', digestOptIn: true }),
      });
      assert.equal(post.status, 401);
    },
    { seedStreets: false }
  ));

test('GET /road-alerts/preferences rejects an unregistered email with 404', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/road-alerts/preferences?email=nobody@example.com&serviceKey=mk_whatever`
      );
      assert.equal(response.status, 404);
    },
    { seedStreets: false }
  ));
