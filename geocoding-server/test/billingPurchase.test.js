const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { upsertUser, getUser, recordUsage } = require('../src/users');

// POST /billing/purchase completes a bulk-geocoding purchase. captureOrder()
// (billing.js) is a deliberate stub -- no real PayPal verification happens
// -- so these tests check what the stub *does* do: validate the tier
// against server-side pricing (never trust a client-supplied price) and
// top up the user's quota unconditionally once that validates.

function makeTempDbFile() {
  const dbPath = path.join(os.tmpdir(), `billing-purchase-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE streets (id INTEGER PRIMARY KEY);');
  db.close();
  return dbPath;
}

function freshServer() {
  delete require.cache[require.resolve('../src/server')];
  return require('../src/server');
}

function withServer(setup, callback) {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  process.env.USERS_DB_PATH = ':memory:';
  const { app, db, usersDb } = freshServer();
  setup(usersDb);

  const server = app.listen(0);
  return Promise.resolve(callback(server.address().port, usersDb))
    .finally(() => {
      server.close();
      db.close();
      usersDb.close();
      fs.unlinkSync(dbPath);
      delete process.env.GEOCODING_DB_PATH;
      delete process.env.USERS_DB_PATH;
    });
}

test('POST /billing/purchase tops up an existing user and returns the new quota', () =>
  withServer(
    (usersDb) => {
      upsertUser(usersDb, 'alice@example.com', 5000);
      recordUsage(usersDb, 'alice@example.com', 4800);
    },
    async (port, usersDb) => {
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

      assert.equal(getUser(usersDb, 'alice@example.com').tier, 6000);
    }
  ));

test('POST /billing/purchase creates a new user if none exists yet', () =>
  withServer(
    () => {},
    async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newbie@example.com', addressCount: 500, orderId: 'ORDER-456' }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.tier, 500);
      assert.equal(body.usedThisPeriod, 0);
    }
  ));

test('POST /billing/purchase rejects an addressCount with no matching pricing tier', () =>
  withServer(
    () => {},
    async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/billing/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', addressCount: 999, orderId: 'ORDER-789' }),
      });

      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /no pricing tier/);
    }
  ));

test('POST /billing/purchase rejects a malformed email or missing orderId', () =>
  withServer(
    () => {},
    async (port) => {
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
    }
  ));

test('POST /billing/purchase ignores a client-supplied price and uses server-side pricing', () =>
  withServer(
    () => {},
    async (port) => {
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
    }
  ));
