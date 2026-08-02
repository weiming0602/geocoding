const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { upsertUser, recordUsage } = require('../src/users');

// GET /quota is a read-only status lookup for a Plan & Quota screen -- unlike
// checkQuota()/useQuota() in quota.js, it never gates or records anything.

function makeTempDbFile() {
  const dbPath = path.join(os.tmpdir(), `quota-endpoint-test-${Date.now()}-${Math.random()}.sqlite`);
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
  return Promise.resolve(callback(server.address().port))
    .finally(() => {
      server.close();
      db.close();
      usersDb.close();
      fs.unlinkSync(dbPath);
      delete process.env.GEOCODING_DB_PATH;
      delete process.env.USERS_DB_PATH;
    });
}

test('GET /quota reports tier, usage, and remaining for a known email', () =>
  withServer(
    (usersDb) => {
      upsertUser(usersDb, 'alice@example.com', 10000);
      recordUsage(usersDb, 'alice@example.com', 1500);
    },
    async (port) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/quota?email=${encodeURIComponent('alice@example.com')}`
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.email, 'alice@example.com');
      assert.equal(body.tier, 10000);
      assert.equal(body.usedThisPeriod, 1500);
      assert.equal(body.remaining, 8500);
      assert.match(body.periodStart, /^\d{4}-\d{2}-01$/);
    }
  ));

test('GET /quota returns 404 for an unknown email', () =>
  withServer(
    () => {},
    async (port) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/quota?email=${encodeURIComponent('nobody@example.com')}`
      );

      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error, /no active subscription/);
    }
  ));

test('GET /quota returns 400 for a missing or malformed email', () =>
  withServer(
    () => {},
    async (port) => {
      const missing = await fetch(`http://127.0.0.1:${port}/quota`);
      assert.equal(missing.status, 400);

      const malformed = await fetch(`http://127.0.0.1:${port}/quota?email=not-an-email`);
      assert.equal(malformed.status, 400);
    }
  ));

test('GET /quota never records usage or mutates it', () =>
  withServer(
    (usersDb) => {
      upsertUser(usersDb, 'alice@example.com', 10000);
      recordUsage(usersDb, 'alice@example.com', 42);
    },
    async (port) => {
      await fetch(`http://127.0.0.1:${port}/quota?email=${encodeURIComponent('alice@example.com')}`);
      const response = await fetch(
        `http://127.0.0.1:${port}/quota?email=${encodeURIComponent('alice@example.com')}`
      );
      const body = await response.json();
      assert.equal(body.usedThisPeriod, 42);
    }
  ));
