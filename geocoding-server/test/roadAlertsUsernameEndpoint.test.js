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

test('GET /road-alerts/username returns null before one is set', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(
        `http://127.0.0.1:${port}/road-alerts/username?email=${TEST_EMAIL}&serviceKey=${serviceKey}`
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.username, null);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/username sets a display name', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const post = await fetch(`http://127.0.0.1:${port}/road-alerts/username`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, username: '  Alice R  ' }),
      });
      assert.equal(post.status, 200);
      assert.equal((await post.json()).username, 'Alice R');

      const get = await fetch(
        `http://127.0.0.1:${port}/road-alerts/username?email=${TEST_EMAIL}&serviceKey=${serviceKey}`
      );
      assert.equal((await get.json()).username, 'Alice R');
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/username rejects an empty or too-long name', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const empty = await fetch(`http://127.0.0.1:${port}/road-alerts/username`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, username: '   ' }),
      });
      assert.equal(empty.status, 400);

      const tooLong = await fetch(`http://127.0.0.1:${port}/road-alerts/username`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, username: 'x'.repeat(41) }),
      });
      assert.equal(tooLong.status, 400);
    },
    { seedStreets: false }
  ));

test('GET and POST /road-alerts/username reject a wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerTestAccount(usersDb);

      const get = await fetch(
        `http://127.0.0.1:${port}/road-alerts/username?email=${TEST_EMAIL}&serviceKey=mk_wrong`
      );
      assert.equal(get.status, 401);

      const post = await fetch(`http://127.0.0.1:${port}/road-alerts/username`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey: 'mk_wrong', username: 'Alice R' }),
      });
      assert.equal(post.status, 401);
    },
    { seedStreets: false }
  ));

test('GET /road-alerts/username rejects an unregistered email with 404', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/road-alerts/username?email=nobody@example.com&serviceKey=mk_whatever`
      );
      assert.equal(response.status, 404);
    },
    { seedStreets: false }
  ));
