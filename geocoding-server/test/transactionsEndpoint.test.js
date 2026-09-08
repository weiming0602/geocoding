const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// withTestServer deletes ADMIN_PASSCODE before every test (see helpers.js),
// so GET /admin/transactions is unauthorized by default -- each test here
// sets it explicitly where it needs the endpoint to actually succeed.

test('GET /admin/transactions rejects a request with no passcode, ADMIN_PASSCODE unset', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/admin/transactions`);
      assert.equal(response.status, 401);
    },
    { seedStreets: false }
  ));

test('GET /admin/transactions rejects a wrong passcode', () =>
  withTestServer(
    async ({ port }) => {
      process.env.ADMIN_PASSCODE = 'correct-horse';
      try {
        const response = await fetch(`http://127.0.0.1:${port}/admin/transactions?passcode=wrong`);
        assert.equal(response.status, 401);
      } finally {
        delete process.env.ADMIN_PASSCODE;
      }
    },
    { seedStreets: false }
  ));

test('GET /admin/transactions returns transactions newest-first given the correct passcode', () =>
  withTestServer(
    async ({ port }) => {
      process.env.ADMIN_PASSCODE = 'correct-horse';
      try {
        await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'alice@example.com', addressCount: 1000, orderId: 'ORDER-1' }),
        });
        await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'bob@example.com', addressCount: 500, orderId: 'ORDER-2' }),
        });

        const response = await fetch(
          `http://127.0.0.1:${port}/admin/transactions?passcode=correct-horse`
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.transactions.length, 2);
        assert.equal(body.transactions[0].email, 'bob@example.com');
        assert.equal(body.transactions[0].orderId, 'ORDER-2');
        assert.equal(body.transactions[0].addressCount, 500);
        assert.equal(body.transactions[0].priceCents, 900);
        assert.equal(body.transactions[1].email, 'alice@example.com');
      } finally {
        delete process.env.ADMIN_PASSCODE;
      }
    },
    { seedStreets: false }
  ));

test('POST /billing/purchase records a transaction row', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const response = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', addressCount: 1000, orderId: 'ORDER-1' }),
      });
      assert.equal(response.status, 200);

      const { rows } = await usersDb.query('SELECT * FROM transactions');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].email, 'alice@example.com');
      assert.equal(rows[0].order_id, 'ORDER-1');
      assert.equal(rows[0].address_count, 1000);
      assert.equal(rows[0].price_cents, 1500);
      assert.equal(rows[0].tier, 1000);
      assert.equal(rows[0].notified_at, null);
    },
    { seedStreets: false }
  ));
