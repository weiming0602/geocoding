const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');
const { registerAccount } = require('../src/roadAlertsAccounts');

test('POST then DELETE /road-signals/live-position round-trips correctly', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const account = await registerAccount(usersDb, 'driver@example.com');

      const post = await fetch(`http://127.0.0.1:${port}/road-signals/live-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: account.service_key,
          latitude: 43.65,
          longitude: -70.25,
          heading: 90,
        }),
      });
      assert.equal(post.status, 200);

      const { rows: afterPost } = await usersDb.query(
        'SELECT * FROM road_alerts_live_positions WHERE account_id = $1',
        [account.id]
      );
      assert.equal(afterPost.length, 1);

      const del = await fetch(
        `http://127.0.0.1:${port}/road-signals/live-position?email=driver@example.com&serviceKey=${account.service_key}`,
        { method: 'DELETE' }
      );
      assert.equal(del.status, 200);

      const { rows: afterDelete } = await usersDb.query(
        'SELECT * FROM road_alerts_live_positions WHERE account_id = $1',
        [account.id]
      );
      assert.equal(afterDelete.length, 0);
    },
    { seedStreets: false }
  ));

test('POST /road-signals/live-position rejects a non-numeric latitude', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const account = await registerAccount(usersDb, 'driver@example.com');

      const response = await fetch(`http://127.0.0.1:${port}/road-signals/live-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: account.service_key,
          latitude: 'not-a-number',
          longitude: -70.25,
        }),
      });

      assert.equal(response.status, 400);
    },
    { seedStreets: false }
  ));
