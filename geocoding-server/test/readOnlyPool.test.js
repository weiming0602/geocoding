const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// src/server.js's geocoding pool must never accept writes, no matter what
// GEOCODING_DSN points at -- see createReadOnlyPool in src/db.js and the
// "geocoding-server's DB connection is opened read-only" rule in
// CLAUDE.md. This guards against that guarantee silently regressing.

test('the geocoding pool rejects writes', () =>
  withTestServer(async ({ db }) => {
    await assert.rejects(
      () => db.query('CREATE TABLE _should_not_be_created (id int)'),
      /read-only transaction/
    );
  }));
