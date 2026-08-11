const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { upsertUser, getUser } = require('../src/users');
const { withTestServer } = require('./helpers');

// allowsTestEmptyServiceKey() (server.js) reads process.env at request
// time, not at server startup, so setting it is enough to affect the
// next fetch() -- but it must happen *inside* withTestServer's
// callback, after the fresh require it does internally (which itself
// clears this var, precisely so a real .env's setting can't leak into
// a test that isn't opting into it -- see helpers.js).
function withFlagEnabled(callback) {
  return async (ctx) => {
    const saved = process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = 'true';
    try {
      await callback(ctx);
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = saved;
      else delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    }
  };
}

test('POST /geocode/batch rejects an empty serviceKey by default', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await upsertUser(usersDb, 'alice@example.com', 100);

      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          serviceKey: '',
          fileContent: '997 Pequawket Trl, Standish, ME 04091',
        }),
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /serviceKey/);
    },
    { seedStreets: false }
  ));

test('POST /geocode/batch accepts an empty serviceKey when ALLOW_TEST_EMPTY_SERVICE_KEY=true', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      await upsertUser(usersDb, 'alice@example.com', 100);

      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          serviceKey: '',
          fileContent: '997 Pequawket Trl, Standish, ME 04091',
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.results[0].success, true);
    })
  ));

test('ALLOW_TEST_EMPTY_SERVICE_KEY=true still rejects a wrong (non-empty) key', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      await upsertUser(usersDb, 'alice@example.com', 100);

      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          serviceKey: 'mk_wrong',
          fileContent: '997 Pequawket Trl, Standish, ME 04091',
        }),
      });

      assert.equal(response.status, 401);
    }),
    { seedStreets: false }
  ));

test('POST /geocode/batch with no email at all still rejects by default', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileContent: '997 Pequawket Trl, Standish, ME 04091' }),
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /email/);
    },
    { seedStreets: false }
  ));

test('POST /geocode/batch with no email at all and a filePath outside the allowed directory is rejected, not read', () =>
  withTestServer(
    withFlagEnabled(async ({ port }) => {
      // With no email/serviceKey at all and the flag set, this request
      // reaches resolveAddresses() with zero authentication -- this is
      // the exact shape of the arbitrary-file-read this repo's own
      // .env (PayPal/AWS credentials) was reachable through before
      // readAddressLines started restricting filePath to the OS temp dir.
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: path.join(__dirname, '..', '.env') }),
      });

      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /filePath must be inside/);
    })
  ));

test('POST /geocode/batch with no email at all runs as a pure smoke test when the flag is set', () =>
  withTestServer(
    withFlagEnabled(async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileContent: '997 Pequawket Trl, Standish, ME 04091' }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.results[0].success, true);
      // No account was involved -- no quota fields at all, not even zero.
      assert.equal('usedThisPeriod' in body, false);
      assert.equal('remaining' in body, false);
      assert.equal('tier' in body, false);
    })
  ));

test('POST /geocode/batch with a well-formed email still requires a real account, even with the flag set', () =>
  withTestServer(
    withFlagEnabled(async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nobody@example.com',
          fileContent: '997 Pequawket Trl, Standish, ME 04091',
        }),
      });

      assert.equal(response.status, 404);
    }),
    { seedStreets: false }
  ));

test('POST /geocode/batch/download with no email at all streams a ZIP with no X-Quota header', () =>
  withTestServer(
    withFlagEnabled(async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileContent: '997 Pequawket Trl, Standish, ME 04091' }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/zip');
      assert.equal(response.headers.get('x-quota'), null);
    }),
    { seedStreets: false }
  ));

test('POST /geocode/batch/email still requires a real email even with the flag set', () =>
  withTestServer(
    withFlagEnabled(async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: '/nonexistent/path.txt',
          fileContent: '997 Pequawket Trl, Standish, ME 04091',
        }),
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /email/);
    }),
    { seedStreets: false }
  ));

test("POST /geocode/batch's no-email path doesn't touch any account's usage", () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      await upsertUser(usersDb, 'alice@example.com', 100);

      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileContent: '997 Pequawket Trl, Standish, ME 04091' }),
      });

      assert.equal(response.status, 200);
      assert.equal((await getUser(usersDb, 'alice@example.com')).used_this_period, 0);
    }),
    { seedStreets: false }
  ));
