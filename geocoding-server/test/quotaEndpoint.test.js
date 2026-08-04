const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser, recordUsage } = require('../src/users');
const { withTestServer } = require('./helpers');

// GET /quota is a read-only status lookup for a Plan & Quota screen -- unlike
// checkQuota()/useQuota() in quota.js, it never gates or records anything.
// It never touches the geocoding database, so these tests skip that fixture.

test('GET /quota reports tier, usage, and remaining for a known email', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await upsertUser(usersDb, 'alice@example.com', 10000);
      await recordUsage(usersDb, 'alice@example.com', 1500);

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
    },
    { seedStreets: false }
  ));

test('GET /quota returns 404 for an unknown email', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/quota?email=${encodeURIComponent('nobody@example.com')}`
      );

      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error, /no active subscription/);
    },
    { seedStreets: false }
  ));

test('GET /quota returns 400 for a missing or malformed email', () =>
  withTestServer(
    async ({ port }) => {
      const missing = await fetch(`http://127.0.0.1:${port}/quota`);
      assert.equal(missing.status, 400);

      const malformed = await fetch(`http://127.0.0.1:${port}/quota?email=not-an-email`);
      assert.equal(malformed.status, 400);
    },
    { seedStreets: false }
  ));

test('GET /quota never records usage or mutates it', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await upsertUser(usersDb, 'alice@example.com', 10000);
      await recordUsage(usersDb, 'alice@example.com', 42);

      await fetch(`http://127.0.0.1:${port}/quota?email=${encodeURIComponent('alice@example.com')}`);
      const response = await fetch(
        `http://127.0.0.1:${port}/quota?email=${encodeURIComponent('alice@example.com')}`
      );
      const body = await response.json();
      assert.equal(body.usedThisPeriod, 42);
    },
    { seedStreets: false }
  ));
