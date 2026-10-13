const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser } = require('../src/users');
const { withTestServer } = require('./helpers');

// 997 Pequawket Trl, Standish, ME 04091 is the standard seeded fixture
// address used throughout this test suite (see geocode.test.js) --
// resolves to match.id 12 against the default makeFixtureDsn() seed.
const FIXTURE_ADDRESS = '997 Pequawket Trl, Standish, ME 04091';

test('POST /geocode with no credentials succeeds for the first 10 requests from one IP', () =>
  withTestServer(async ({ port }) => {
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS }),
      });
      assert.equal(response.status, 200, `request ${i + 1} should succeed`);
    }
  }));

test('POST /geocode with no credentials returns 429 on the 11th request in under a minute', () =>
  withTestServer(async ({ port }) => {
    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS }),
      });
    }
    const eleventh = await fetch(`http://127.0.0.1:${port}/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: FIXTURE_ADDRESS }),
    });
    assert.equal(eleventh.status, 429);
    const body = await eleventh.json();
    assert.match(body.error, /Rate limit exceeded/);
  }));

test('POST /geocode with valid credentials draws from quota and is never rate-limited', () =>
  withTestServer(async ({ port, usersDb }) => {
    const user = await upsertUser(usersDb, 'alice@example.com', 1000);

    for (let i = 0; i < 15; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS, email: 'alice@example.com', serviceKey: user.service_key }),
      });
      assert.equal(response.status, 200, `authenticated request ${i + 1} should succeed past the 10/min anonymous limit`);
    }

    const { rows } = await usersDb.query('SELECT used_this_period FROM users WHERE email = $1', ['alice@example.com']);
    assert.equal(rows[0].used_this_period, 15);
  }));

test('POST /geocode with an invalid service key returns 401, not a silent fall-back to the free path', () =>
  withTestServer(async ({ port, usersDb }) => {
    await upsertUser(usersDb, 'alice@example.com', 1000);

    const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: FIXTURE_ADDRESS, email: 'alice@example.com', serviceKey: 'wrong-key' }),
    });
    assert.equal(response.status, 401);
  }));

test('POST /reverse-geocode with no credentials is rate-limited the same way as /geocode, sharing the same IP bucket', () =>
  withTestServer(async ({ port }) => {
    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS }),
      });
    }
    // The 11th unauthenticated request, even to the *other* endpoint,
    // should already be blocked -- same IP, same day, same bucket.
    const response = await fetch(`http://127.0.0.1:${port}/reverse-geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 43.9, longitude: -70.9 }),
    });
    assert.equal(response.status, 429);
  }));

test('POST /reverse-geocode with valid credentials draws from quota', () =>
  withTestServer(async ({ port, usersDb }) => {
    const user = await upsertUser(usersDb, 'alice@example.com', 1000);

    const response = await fetch(`http://127.0.0.1:${port}/reverse-geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 43.9, longitude: -70.9, email: 'alice@example.com', serviceKey: user.service_key }),
    });
    assert.equal(response.status, 200);

    const { rows } = await usersDb.query('SELECT used_this_period FROM users WHERE email = $1', ['alice@example.com']);
    assert.equal(rows[0].used_this_period, 1);
  }));

test('req.ip resolves the real client IP from X-Forwarded-For, not the proxy', () =>
  withTestServer(async ({ port }) => {
    // Two different claimed client IPs, each sent 10 requests -- if
    // trust proxy weren't configured, both would land in the same
    // bucket (the test runner's own loopback address) and the second
    // IP's 10th request would already be blocked by the first IP's
    // prior traffic. It isn't, which proves they're tracked separately.
    for (const ip of ['203.0.113.10', '203.0.113.11']) {
      for (let i = 0; i < 10; i++) {
        const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify({ address: FIXTURE_ADDRESS }),
        });
        assert.equal(response.status, 200, `${ip} request ${i + 1} should succeed`);
      }
    }
  }));
