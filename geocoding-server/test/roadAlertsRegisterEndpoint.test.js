const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

test('POST /road-alerts/register creates a new account', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com' }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.email, 'alice@example.com');
      assert.match(body.serviceKey, /^mk_[0-9a-f]{48}$/);
      assert.equal(body.alreadyRegistered, false);
      assert.ok(body.registeredAt);
      assert.equal(body.digestOptIn, false);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/register is idempotent -- re-registering returns the same key', () =>
  withTestServer(
    async ({ port }) => {
      const register = () =>
        fetch(`http://127.0.0.1:${port}/road-alerts/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'alice@example.com' }),
        }).then((r) => r.json());

      const first = await register();
      const second = await register();

      assert.equal(second.serviceKey, first.serviceKey);
      assert.equal(second.registeredAt, first.registeredAt);
      assert.equal(second.alreadyRegistered, true);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/register rejects a missing or malformed email with 400', () =>
  withTestServer(
    async ({ port }) => {
      const missing = await fetch(`http://127.0.0.1:${port}/road-alerts/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400);

      const malformed = await fetch(`http://127.0.0.1:${port}/road-alerts/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      });
      assert.equal(malformed.status, 400);
    },
    { seedStreets: false }
  ));
