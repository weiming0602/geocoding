const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createReadOnlyPool } = require('./db');

const { ensureRoadAlertsAccountsTable } = require('./roadAlertsAccounts');
const { ensureRoadAlertsSurfacedLogTable } = require('./roadAlertsSurfacedLog');
const { ensureRoadAlertsTopicsTable } = require('./roadAlertsTopics');
const { ensureRoadAlertsStatementsTable } = require('./roadAlertsStatements');
const { ensureTestWeightedPointsTable } = require('./testWeightedPoints');
const { ensureWeightedPointsTable } = require('./weightedPoints');
const { ensureTestRoadSignalsTable } = require('./testRoadSignals');
const { openUsersDb } = require('./users');
const { ensureFeedbackTable } = require('./feedback');
const { ensureTransactionsTable } = require('./transactions');
const { ensureGeocodeRateLimitsTable } = require('./geocodeRateLimit');
const { ensureLlmGeocodeAssistsTable } = require('./llmGeocodeAssists');
const { ensureRoadAlertsPushTables } = require('./roadAlertsPush');

// Shared plumbing for the three entry points: server.js (every route, one
// process -- local dev and the test suite), geocodingServer.js and
// roadAlertsServer.js (one route group each, so production can run them
// as separate processes on the same droplet -- see
// ops/road-alerts-server.service and ops/nginx-api.conf.example).
// Nothing here holds module-level state: every entry point (and every
// test's fresh require of one) gets its own pools and app.

// Unix socket, peer-authenticated (no password) -- the socket path must be
// percent-encoded into the URI's host component (%2Fvar%2Frun%2Fpostgresql),
// since node-postgres only honors a Unix socket path passed this way or as
// a plain `host` config field, not as a bare connection-string host.
// Functions, not constants, so a test's GEOCODING_DSN/USERS_DSN (set just
// before a fresh require of an entry point) is always the one used.
function geocodingDsn() {
  return process.env.GEOCODING_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding';
}

function usersDsn() {
  return process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lets /geocode/batch and /geocode/batch/download run with no email and
// no serviceKey at all -- a pure smoke test with no account/quota
// involved (see the emailProvided checks in each route), and lets an
// email that IS given skip the serviceKey check specifically (see
// quota.js's allowsEmptyServiceKeyForTesting). /geocode/batch/email
// still requires a real email regardless -- that's the address the
// results actually get sent to, not just an account lookup key. Read at
// request time (like billing.js's isConfigured()), not cached at
// startup, so it can change without a restart. Never set this anywhere
// real customers' quota is at stake.
function allowsTestEmptyServiceKey() {
  return process.env.ALLOW_TEST_EMPTY_SERVICE_KEY === 'true';
}

// Gates the /road-alerts/test/weighted-points routes (see
// testWeightedPoints.js) -- off by default, same read-at-request-time
// spirit as allowsTestEmptyServiceKey() just above, for the same reason
// (can be flipped without a restart, and a real .env's setting is never
// picked up mid-test -- see helpers.js's withTestServer). Never enable
// this anywhere the "weighted points" wording could be mistaken for a
// real per-user routine store; it isn't one -- see the comment atop
// testWeightedPoints.js.
function allowsTestWeightedPoints() {
  return process.env.ALLOW_TEST_WEIGHTED_POINTS === 'true';
}

// Gates the /road-alerts/test/signals routes and their merge into
// GET /road-signals (see testRoadSignals.js) -- off by default, same
// read-at-request-time spirit as the two gates just above. Never enable
// this anywhere a real driver could mistake a fake, developer-seeded
// hazard for an actual live one.
function allowsTestRoadSignals() {
  return process.env.ALLOW_TEST_ROAD_SIGNALS === 'true';
}

/**
 * Opens both pools. `db` is enforced read-only at the Postgres session
 * level (see createReadOnlyPool in db.js); never add a write path against
 * it (only usersDb is writable, via src/users.js). usersDbPromise opens
 * eagerly and creates every table either route group needs -- all
 * CREATE TABLE IF NOT EXISTS, so both production processes running this
 * against the same geocoding_users database is harmless.
 */
function createDatabases() {
  const db = createReadOnlyPool(geocodingDsn());
  const usersDbPromise = openUsersDb(usersDsn()).then(async (pool) => {
    await ensureFeedbackTable(pool);
    await ensureTransactionsTable(pool);
    await ensureRoadAlertsAccountsTable(pool);
    await ensureRoadAlertsSurfacedLogTable(pool);
    await ensureRoadAlertsTopicsTable(pool);
    await ensureRoadAlertsStatementsTable(pool);
    await ensureTestWeightedPointsTable(pool);
    await ensureWeightedPointsTable(pool);
    await ensureTestRoadSignalsTable(pool);
    await ensureRoadAlertsPushTables(pool);
    await ensureGeocodeRateLimitsTable(pool);
    await ensureLlmGeocodeAssistsTable(pool);
    return pool;
  });
  return { db, usersDbPromise };
}

/**
 * The Express app every entry point starts from, before any routes.
 * `logRequests` is true only when actually running as a server (not
 * when test/helpers.js's withTestServer requires an entry point) --
 * otherwise every test request across the whole suite would print a log
 * line, drowning out real output. Goes to stdout; under systemd that's
 * captured by journald automatically, no separate log file needed.
 */
function createBaseApp({ logRequests }) {
  const app = express();
  // nginx (see ops/nginx-api.conf.example and the deployed droplets'
  // /etc/nginx/sites-enabled configs) already sets X-Real-IP/
  // X-Forwarded-For correctly and always connects from the same box --
  // 'loopback' trusts exactly that one hop, so req.ip resolves to the
  // real client IP instead of nginx's own address. Required for
  // geocodeRateLimit.js's per-IP tracking to work at all; without it,
  // every caller behind the proxy would share one bucket.
  app.set('trust proxy', 'loopback');
  app.use(cors());
  if (logRequests) {
    app.use(morgan('combined'));
  }
  // batchGeocode.js has no cap on address count, but Express itself still
  // needs some finite body-size ceiling for fileContent uploads (default
  // 100kb is far too small). This is just that technical floor, not a
  // business rule -- raise it further if a real batch ever needs to.
  app.use(express.json({ limit: '200mb' }));
  return app;
}

/** Listens on `port` and prints the startup banner plus a warning for every test-only flag that's set. */
function startServer(app, { name, port }) {
  app.listen(port, () => {
    console.log(`${name} listening on http://localhost:${port}`);
    console.log(`using database: ${geocodingDsn()}`);
    if (allowsTestEmptyServiceKey()) {
      console.warn(
        '⚠ ALLOW_TEST_EMPTY_SERVICE_KEY is set -- batch geocoding accepts an empty ' +
          'service key for ANY known email. Never enable this where real customers’ ' +
          'quota is at stake.'
      );
    }
    if (allowsTestWeightedPoints()) {
      console.warn(
        '⚠ ALLOW_TEST_WEIGHTED_POINTS is set -- /road-alerts/test/weighted-points is ' +
          'live. These are fake, developer-seeded routine points for testing only, ' +
          'never a real per-user routine store.'
      );
    }
    if (allowsTestRoadSignals()) {
      console.warn(
        '⚠ ALLOW_TEST_ROAD_SIGNALS is set -- /road-alerts/test/signals is live and ' +
          'GET /road-signals will merge in fake, developer-seeded hazards. These never ' +
          'expire on their own -- never enable this where a real driver could see one.'
      );
    }
  });
}

module.exports = {
  EMAIL_PATTERN,
  allowsTestEmptyServiceKey,
  allowsTestWeightedPoints,
  allowsTestRoadSignals,
  createDatabases,
  createBaseApp,
  startServer,
};
