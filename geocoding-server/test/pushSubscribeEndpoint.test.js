const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');
const { registerAccount } = require('../src/roadAlertsAccounts');

test('POST /road-signals/push-subscribe stores a subscription for a valid account', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const account = await registerAccount(usersDb, 'driver@example.com');

      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: account.service_key,
          subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } },
        }),
      });

      assert.equal(response.status, 200);
      const { rows } = await usersDb.query('SELECT * FROM road_alerts_push_subscriptions WHERE account_id = $1', [
        account.id,
      ]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].endpoint, 'https://push.example/abc');
    },
    { seedStreets: false }
  ));

test('POST /road-signals/push-subscribe rejects a wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerAccount(usersDb, 'driver@example.com');

      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: 'wrong-key',
          subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } },
        }),
      });

      assert.equal(response.status, 401);
    },
    { seedStreets: false }
  ));
