const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser, getUser, recordUsage } = require('../src/users');
const { withTestServer } = require('./helpers');

// POST /billing/purchase completes a bulk-geocoding purchase. captureOrder()
// (billing.js) is a deliberate stub -- no real PayPal verification happens
// -- so these tests check what the stub *does* do: validate the tier
// against server-side pricing (never trust a client-supplied price) and
// top up the user's quota unconditionally once that validates. It never
// touches the geocoding database, so these tests skip that fixture.

test('POST /billing/purchase tops up an existing user and returns the new quota', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await upsertUser(usersDb, 'alice@example.com', 5000);
      await recordUsage(usersDb, 'alice@example.com', 4800);

      const response = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', addressCount: 1000, orderId: 'ORDER-123' }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.tier, 6000);
      assert.equal(body.usedThisPeriod, 4800);
      assert.equal(body.remaining, 1200);
      assert.equal(body.purchased, 1000);
      assert.equal(body.priceCents, 1500);
      assert.equal(body.stubbed, true);

      assert.equal((await getUser(usersDb, 'alice@example.com')).tier, 6000);
    },
    { seedStreets: false }
  ));

test('POST /billing/purchase creates a new user if none exists yet', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newbie@example.com', addressCount: 500, orderId: 'ORDER-456' }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.tier, 500);
      assert.equal(body.usedThisPeriod, 0);
    },
    { seedStreets: false }
  ));

test('POST /billing/purchase rejects an addressCount with no matching pricing tier', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', addressCount: 999, orderId: 'ORDER-789' }),
      });

      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /no pricing tier/);
    },
    { seedStreets: false }
  ));

test('POST /billing/purchase rejects a malformed email or missing orderId', () =>
  withTestServer(
    async ({ port }) => {
      const badEmail = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', addressCount: 500, orderId: 'ORDER-1' }),
      });
      assert.equal(badEmail.status, 400);

      const missingOrder = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', addressCount: 500 }),
      });
      assert.equal(missingOrder.status, 400);
    },
    { seedStreets: false }
  ));

test('POST /billing/purchase ignores a client-supplied price and uses server-side pricing', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A client claiming addressCount:10000 should be charged/validated
        // at the real $75 tier regardless of any priceCents it sends.
        body: JSON.stringify({
          email: 'alice@example.com',
          addressCount: 10000,
          priceCents: 1,
          orderId: 'ORDER-999',
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.priceCents, 7500);
      assert.equal(body.tier, 10000);
    },
    { seedStreets: false }
  ));
