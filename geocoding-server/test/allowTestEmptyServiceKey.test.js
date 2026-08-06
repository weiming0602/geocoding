const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser } = require('../src/users');
const { withTestServer } = require('./helpers');

// allowsTestEmptyServiceKey() (server.js) reads process.env at request
// time, not at server startup, so toggling it around each fetch() call
// below is enough -- no need to re-require the server module.

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
  withTestServer(async ({ port, usersDb }) => {
    await upsertUser(usersDb, 'alice@example.com', 100);
    const saved = process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = 'true';

    try {
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
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = saved;
      else delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    }
  }));

test('ALLOW_TEST_EMPTY_SERVICE_KEY=true still rejects a wrong (non-empty) key', () =>
  withTestServer(async ({ port, usersDb }) => {
    await upsertUser(usersDb, 'alice@example.com', 100);
    const saved = process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = 'true';

    try {
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
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = saved;
      else delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    }
  }));
