const crypto = require('crypto');
const zlib = require('zlib');

const { Pool } = require('../src/db');

// Unix socket, peer-authenticated -- same convention as src/server.js's
// default DSNs. Percent-encoding the socket path into the URI's host
// component is required: node-postgres only treats a Unix socket path as
// such when it comes from this form or a plain `host` config field, never
// from a bare connection-string host.
const SOCKET_HOST = '%2Fvar%2Frun%2Fpostgresql';
const ADMIN_DSN = `postgresql://my_ai@${SOCKET_HOST}/postgres`;

/** Parses local file header entries back out of a ZIP built by buildZip(). */
function parseZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    entries.push({ name, content: content.toString('utf8') });
    offset = dataStart + compressedSize;
  }
  return entries;
}

/** Computes a WKT LINESTRING's bounding box, mirroring what the Python ingest computes. */
function bboxOf(wkt) {
  const coords = wkt
    .replace(/^LINESTRING\s*\(/, '')
    .replace(/\)$/, '')
    .split(',')
    .map((pair) => pair.trim().split(/\s+/).map(Number));
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Creates a throwaway Postgres database (not just a schema) so each test
 * gets full isolation, mirroring how the old suite gave each test its own
 * in-memory/temp-file SQLite database. Returns a Pool already pointed at
 * it, plus its DSN (for tests that need to point a freshly-required
 * src/server.js at it via env vars) and a drop() to tear it all down.
 */
async function createTestDatabase({ postgis = true, pgrouting = false, trgm = true } = {}) {
  const name = `geocoding_test_${crypto.randomBytes(8).toString('hex')}`;

  const admin = new Pool({ connectionString: ADMIN_DSN });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dsn = `postgresql://my_ai@${SOCKET_HOST}/${name}`;
  const pool = new Pool({ connectionString: dsn });
  if (postgis) {
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
  }
  if (pgrouting) {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgrouting');
  }
  if (trgm) {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  }

  async function drop() {
    await pool.end();
    const admin2 = new Pool({ connectionString: ADMIN_DSN });
    await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin2.end();
  }

  return { pool, dsn, drop };
}

/**
 * Populates a pool's streets/street_names tables with a handful of
 * fixture streets, covering every matching scenario the geocode/
 * reverseGeocode tests need: a multi-segment named street, one with no
 * address range, a same-name collision across states, a ZIP-boundary
 * street with different zipl/zipr, and an alternate TIGER name for the
 * same physical segment.
 */
async function seedFixtureStreets(pool) {
  await pool.query(`
    CREATE TABLE streets (
      id BIGSERIAL PRIMARY KEY,
      tlid TEXT,
      fullname TEXT,
      lfromadd TEXT,
      ltoadd TEXT,
      rfromadd TEXT,
      rtoadd TEXT,
      zipl TEXT,
      zipr TEXT,
      state TEXT,
      state_abbr TEXT,
      geometry TEXT,
      minx DOUBLE PRECISION,
      miny DOUBLE PRECISION,
      maxx DOUBLE PRECISION,
      maxy DOUBLE PRECISION,
      geom geometry(Geometry, 4326)
    );
    CREATE TABLE street_names (
      id BIGSERIAL PRIMARY KEY,
      tlid TEXT NOT NULL,
      fullname TEXT NOT NULL,
      paflag TEXT,
      zipl TEXT,
      zipr TEXT,
      state TEXT,
      state_abbr TEXT
    );
    CREATE TABLE address_points (
      id BIGSERIAL PRIMARY KEY,
      site_uid TEXT NOT NULL,
      address_number INTEGER,
      street_fullname TEXT,
      town TEXT,
      county TEXT,
      state_abbr TEXT,
      geom geometry(Point, 4326)
    );
    CREATE TABLE towns (
      id BIGSERIAL PRIMARY KEY,
      geoid TEXT NOT NULL,
      state TEXT,
      state_abbr TEXT,
      name TEXT,
      geom geometry(MultiPolygon, 4326)
    );
  `);

  // Town boundaries (geocoding/ingest_towns.py) for matchByStreetAndTown,
  // well away from every other fixture: real NH towns whose streets below
  // reproduce real wrong-ZIP addresses -- Lebanon's ZIP is 03766, Derry's
  // 03038, Concord's 03301 -- plus Lebanon, ME (same town name, another
  // state, also with a Forest Ave).
  const towns = [
    ['3300941300', 'New Hampshire', 'NH', 'Lebanon', -72.3, 43.6, -72.2, 43.7],
    ['3301314200', 'New Hampshire', 'NH', 'Concord', -71.6, 43.15, -71.5, 43.25],
    ['3301517940', 'New Hampshire', 'NH', 'Derry', -71.35, 42.86, -71.3, 42.9],
    ['2303139000', 'Maine', 'ME', 'Lebanon', -70.95, 43.35, -70.85, 43.45],
  ];
  for (const [geoid, state, stateAbbr, name, minx, miny, maxx, maxy] of towns) {
    await pool.query(
      `INSERT INTO towns (geoid, state, state_abbr, name, geom)
       VALUES ($1, $2, $3, $4, ST_Multi(ST_MakeEnvelope($5, $6, $7, $8, 4326)))`,
      [geoid, state, stateAbbr, name, minx, miny, maxx, maxy]
    );
  }

  // One address point, in a town/street distinct from the streets fixture
  // above, so tests can verify geocode() prefers an exact point match over
  // interpolation without it interfering with the interpolation-path tests.
  await pool.query(
    `INSERT INTO address_points (site_uid, address_number, street_fullname, town, county, state_abbr, geom)
     VALUES ('test-uid-1', 42, 'Test Point Lane', 'Testville', 'Test County', 'ME',
             ST_SetSRID(ST_MakePoint(-70.5, 43.5), 4326))`
  );
  // A second address point sharing its street name with the "Pequawket
  // Trl" streets/street_names rows below (real ZIP 04091), at a house
  // number (500) outside every interpolation range those rows cover --
  // so tests can prove a ZIP cross-check against street_names' real data
  // for this street (unlike Test Point Lane, which has no street_names
  // entry at all to check against).
  await pool.query(
    `INSERT INTO address_points (site_uid, address_number, street_fullname, town, county, state_abbr, geom)
     VALUES ('test-uid-2', 500, 'Pequawket Trl', 'Standish', 'Cumberland County', 'ME',
             ST_SetSRID(ST_MakePoint(-70.78, 43.83), 4326))`
  );

  // Each side's range holds a single parity, as real TIGER ranges do
  // (~99.98% of sides). Rows 12/14/99/50 follow the common "odd on the
  // left" layout; rows 60/61 are the equally real opposite layout (see
  // geocodeMatching.js's sideFraction) -- which side holds odd numbers is
  // a property of each segment's data, not a fixed rule.
  const rows = [
    {
      id: 12, tlid: '78056932', fullname: 'Pequawket Trl', lfromadd: '989', ltoadd: '999',
      rfromadd: '978', rtoadd: '990', zipl: '04091', zipr: '04091', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)',
    },
    {
      id: 1, tlid: '78060165', fullname: 'Sebago Rd', lfromadd: '', ltoadd: '',
      rfromadd: '', rtoadd: '', zipl: '04074', zipr: '04074', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.748418 43.876127, -70.750996 43.878619)',
    },
    // A second segment of the same named street/ZIP, covering a different
    // address sub-range (real streets are split into many such segments).
    {
      id: 14, tlid: '78012506', fullname: 'Pequawket Trl', lfromadd: '701', ltoadd: '739',
      rfromadd: '700', rtoadd: '720', zipl: '04091', zipr: '04091', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.79 43.83, -70.795 43.835)',
    },
    // Same fullname+zip as id=12/14 but in a different state, to test that
    // state disambiguates when everything else collides.
    {
      id: 99, tlid: '99999999', fullname: 'Pequawket Trl', lfromadd: '101', ltoadd: '199',
      rfromadd: '100', rtoadd: '198', zipl: '04091', zipr: '04091', state: 'New Hampshire', state_abbr: 'NH',
      geometry: 'LINESTRING (-71.0 43.9, -71.01 43.91)',
    },
    // A real-world shape (e.g. "Greely Rd" in the actual dataset): zipl and
    // zipr differ, since the street runs along a ZIP boundary.
    {
      id: 50, tlid: '50000000', fullname: 'Greely Rd', lfromadd: '201', ltoadd: '291',
      rfromadd: '200', rtoadd: '292', zipl: '04021', zipr: '04097', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.2 43.9, -70.21 43.91)',
    },
    // The real shape of "Grove St" in Freeport (ZIP 04032): no range or
    // ZIP on the left at all, odd numbers 99 down to 1 on the right. A
    // fixed "odd numbers are on the left" rule can never find any
    // address on it.
    {
      id: 60, tlid: '60000000', fullname: 'Grove St', lfromadd: '', ltoadd: '',
      rfromadd: '99', rtoadd: '1', zipl: '', zipr: '04032', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.10 43.86, -70.10 43.861)',
    },
    // Both sides populated, parities the other way round from rows 12/50:
    // even numbers on the left, odd on the right.
    {
      id: 61, tlid: '61000000', fullname: 'Swapped Ave', lfromadd: '2', ltoadd: '98',
      rfromadd: '1', rtoadd: '99', zipl: '04032', zipr: '04032', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.12 43.86, -70.12 43.861)',
    },
    // Inside the towns above (see there).
    {
      id: 70, tlid: '70000000', fullname: 'Forest Ave', lfromadd: '1', ltoadd: '99',
      rfromadd: '2', rtoadd: '98', zipl: '03766', zipr: '03766', state: 'New Hampshire', state_abbr: 'NH',
      geometry: 'LINESTRING (-72.25 43.64, -72.25 43.645)',
    },
    {
      id: 71, tlid: '71000000', fullname: 'Franklin St', lfromadd: '1', ltoadd: '99',
      rfromadd: '2', rtoadd: '98', zipl: '03301', zipr: '03301', state: 'New Hampshire', state_abbr: 'NH',
      geometry: 'LINESTRING (-71.55 43.2, -71.55 43.205)',
    },
    {
      id: 72, tlid: '72000000', fullname: 'Franklin St', lfromadd: '1', ltoadd: '99',
      rfromadd: '2', rtoadd: '98', zipl: '03038', zipr: '03038', state: 'New Hampshire', state_abbr: 'NH',
      geometry: 'LINESTRING (-71.33 42.88, -71.33 42.885)',
    },
    {
      id: 73, tlid: '73000000', fullname: 'Forest Ave', lfromadd: '1', ltoadd: '99',
      rfromadd: '2', rtoadd: '98', zipl: '04027', zipr: '04027', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.9 43.4, -70.9 43.405)',
    },
    // Another town's Forest Ave, outside Lebanon NH, ending on its boundary.
    {
      id: 74, tlid: '74000000', fullname: 'Forest Ave', lfromadd: '1', ltoadd: '99',
      rfromadd: '2', rtoadd: '98', zipl: '03784', zipr: '03784', state: 'New Hampshire', state_abbr: 'NH',
      geometry: 'LINESTRING (-72.2 43.65, -72.15 43.65)',
    },
  ];

  for (const row of rows) {
    const [minx, miny, maxx, maxy] = bboxOf(row.geometry);
    await pool.query(
      `INSERT INTO streets
         (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr,
          geometry, minx, miny, maxx, maxy, geom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               ST_GeomFromText($12, 4326))`,
      [
        row.id, row.tlid, row.fullname, row.lfromadd, row.ltoadd, row.rfromadd, row.rtoadd,
        row.zipl, row.zipr, row.state, row.state_abbr, row.geometry, minx, miny, maxx, maxy,
      ]
    );
  }

  // Every streets row needs its own fullname registered as the primary
  // name, or exact/LIKE matching (which now goes through street_names,
  // not streets.fullname directly) would find nothing. zipl/zipr/state/
  // state_abbr are denormalized copies of the matching streets row (see
  // sync_street_names_zip_state in ingest_featnames.py) -- candidateStreets
  // filters on street_names' own copies, not streets', so a mismatch here
  // would silently break matching in tests but not reflect a real bug.
  for (const row of rows) {
    await pool.query(
      `INSERT INTO street_names (tlid, fullname, paflag, zipl, zipr, state, state_abbr)
       VALUES ($1, $2, 'P', $3, $4, $5, $6)`,
      [row.tlid, row.fullname, row.zipl, row.zipr, row.state, row.state_abbr]
    );
  }
  // A real alternate name from the actual dataset: TLID 78056932 (id=12,
  // "Pequawket Trl") is also officially "State Rte 113".
  const primary = rows.find((row) => row.tlid === '78056932');
  await pool.query(
    `INSERT INTO street_names (tlid, fullname, paflag, zipl, zipr, state, state_abbr)
     VALUES ($1, 'State Rte 113', 'A', $2, $3, $4, $5)`,
    [primary.tlid, primary.zipl, primary.zipr, primary.state, primary.state_abbr]
  );
}

/**
 * Builds a throwaway geocoding database seeded with seedFixtureStreets().
 * Returns the Pool itself (matching src/geocode.js's `db.query()`
 * expectation) with a `close()` method attached that drops the whole
 * throwaway database -- so existing call sites just need `await
 * db.close()` instead of the old synchronous `db.close()`.
 */
async function makeDb() {
  const { pool, drop } = await createTestDatabase();
  await seedFixtureStreets(pool);
  pool.close = drop;
  return pool;
}

/**
 * Same fixture data as makeDb(), but for tests that point a freshly
 * required src/server.js (a separate process-wide module, with its own
 * Pool) at the database via GEOCODING_DSN -- so this hands back the DSN
 * itself rather than a connected Pool. drop() ends the setup pool used
 * here and drops the database with FORCE, which also disconnects
 * whatever pool server.js opened against it.
 */
async function makeFixtureDsn() {
  const { pool, dsn, drop } = await createTestDatabase();
  await seedFixtureStreets(pool);
  return { dsn, drop };
}

/**
 * Throwaway users/subscriptions database. Returns a Pool (via
 * openUsersDb, which creates the users table) with a `close()` method
 * that drops the whole throwaway database.
 */
async function makeUsersDb() {
  const { openUsersDb } = require('../src/users');
  const { dsn, drop } = await createTestDatabase({ postgis: false });
  // openUsersDb opens its own pool against the same dsn; drop() ends the
  // one createTestDatabase made (used only for CREATE DATABASE setup) and
  // drops the database with FORCE, which disconnects db's pool too.
  const db = await openUsersDb(dsn);
  db.close = async () => {
    await db.end();
    await drop();
  };
  return db;
}

/**
 * Spins up throwaway geocoding + users databases, points a freshly
 * required src/server.js at them via env vars, and runs `callback({
 * port, db, usersDb })` against a live instance of it. server.js opens
 * its users pool eagerly at require time (not on first request), so
 * every test needs a real (even if unused) throwaway users database --
 * pointing USERS_DSN at one that doesn't exist would reject that promise
 * with nothing to catch it.
 *
 * `seedStreets: false` skips loading the geocode fixture rows, for tests
 * that only exercise user/quota/billing endpoints and never query
 * streets at all.
 *
 * `geoSeed` (only meaningful alongside `seedStreets: false`) is an async
 * function called with a real *writable* pool against the throwaway geo
 * database, before the server (whose own `db` is read-only-enforced, see
 * createReadOnlyPool) ever starts -- for a test needing its own custom
 * fixture (e.g. roadRerouteFixture.js's synthetic street network) rather
 * than the standard seedFixtureStreets rows. `geoOptions` controls that
 * seeding pool's own createTestDatabase() call (e.g. `{ postgis: true,
 * pgrouting: true }`), independent of `seedStreets`'s own default.
 *
 * `serverModule` picks which entry point to start -- '../src/server'
 * (every route, the default) or one half of the production split,
 * '../src/geocodingServer' / '../src/roadAlertsServer' (see
 * serverSplit.test.js). All three export the same { app, db,
 * usersDbPromise } shape.
 */
async function withTestServer(
  callback,
  { seedStreets = true, geoOptions = {}, geoSeed, serverModule = '../src/server' } = {}
) {
  const geo = seedStreets
    ? await makeFixtureDsn()
    : await createTestDatabase({ postgis: false, ...geoOptions }).then(async ({ pool, dsn, drop }) => {
        // Same pattern as makeFixtureDsn: seed via this writable pool, then
        // just discard the reference -- `drop` (returned below) already
        // closes over this same pool and is what ends it, exactly once,
        // whenever the caller's teardown runs. Ending it here too would
        // double-close it.
        if (geoSeed) await geoSeed(pool);
        return { dsn, drop };
      });
  const users = await createTestDatabase({ postgis: false }).then(({ dsn, drop }) => ({
    dsn,
    drop,
  }));

  process.env.GEOCODING_DSN = geo.dsn;
  process.env.USERS_DSN = users.dsn;
  // The route modules too, not just the entry point: they're what
  // actually require roadSignals.js/hereTraffic.js etc., so a test that
  // clears one of those (to reset its module-scope cache -- see
  // roadSignalsEndpoint.test.js's withFetch) only gets a fresh copy if
  // the route module is re-required as well. Same freshness server.js
  // had back when every route lived in it directly.
  for (const mod of [serverModule, '../src/geocodingRoutes', '../src/roadAlertsRoutes']) {
    delete require.cache[require.resolve(mod)];
  }
  const server = require(serverModule);
  const httpServer = server.app.listen(0);
  const usersDb = await server.usersDbPromise;

  // billing.js should always exercise the deliberate stub in tests, never
  // a real Stripe API call -- but dotenv (loaded by server.js, just above)
  // picks up whatever real .env a developer happens to have locally.
  // billing.js reads these at call time, not at require time, so clearing
  // them *after* requiring server.js (dotenv has already run) still forces
  // the stub for every request handled during this test (and the webhook
  // route's "disabled by default" 404). Restored afterward.
  const savedStripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const savedStripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  // Same rationale as the Stripe vars just above, for
  // emailDelivery.js's sendServiceKeyEmail -- a real .env's Resend
  // credentials should never cause a test to attempt a real send.
  const savedResendApiKey = process.env.RESEND_API_KEY;
  const savedResendFromEmail = process.env.RESEND_FROM_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;

  // Same rationale again -- a real .env with ALLOW_TEST_EMPTY_SERVICE_KEY
  // set (see quota.js) should never make the "empty key is rejected by
  // default" tests pass for the wrong reason.
  const savedAllowTestEmptyServiceKey = process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
  delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
  // Same rationale as ALLOW_TEST_EMPTY_SERVICE_KEY just above -- a real
  // .env's ALLOW_TEST_WEIGHTED_POINTS should never make the "disabled by
  // default" tests pass for the wrong reason (see testWeightedPoints.js).
  const savedAllowTestWeightedPoints = process.env.ALLOW_TEST_WEIGHTED_POINTS;
  delete process.env.ALLOW_TEST_WEIGHTED_POINTS;

  // Same rationale again -- a real .env's ADMIN_PASSCODE should never
  // make the "GET /admin/transactions is unauthorized by default" tests
  // pass for the wrong reason (see server.js's /admin/transactions).
  const savedAdminPasscode = process.env.ADMIN_PASSCODE;
  delete process.env.ADMIN_PASSCODE;

  // Same rationale again -- a real .env's HERE_API_KEY should never make
  // the "HERE_API_KEY unset" tests pass for the wrong reason, or make an
  // unrelated test's Texas-location request silently start hitting the
  // real HERE API instead of the fake fetch above.
  const savedHereApiKey = process.env.HERE_API_KEY;
  delete process.env.HERE_API_KEY;

  try {
    return await callback({ port: httpServer.address().port, db: server.db, usersDb });
  } finally {
    httpServer.close();
    await server.db.end();
    await usersDb.end();
    await geo.drop();
    await users.drop();
    delete process.env.GEOCODING_DSN;
    delete process.env.USERS_DSN;
    if (savedStripeSecretKey !== undefined) process.env.STRIPE_SECRET_KEY = savedStripeSecretKey;
    if (savedStripeWebhookSecret !== undefined) process.env.STRIPE_WEBHOOK_SECRET = savedStripeWebhookSecret;
    if (savedResendApiKey !== undefined) process.env.RESEND_API_KEY = savedResendApiKey;
    if (savedResendFromEmail !== undefined) process.env.RESEND_FROM_EMAIL = savedResendFromEmail;
    if (savedAllowTestEmptyServiceKey !== undefined)
      process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = savedAllowTestEmptyServiceKey;
    if (savedAllowTestWeightedPoints !== undefined)
      process.env.ALLOW_TEST_WEIGHTED_POINTS = savedAllowTestWeightedPoints;
    if (savedAdminPasscode !== undefined) process.env.ADMIN_PASSCODE = savedAdminPasscode;
    if (savedHereApiKey !== undefined) process.env.HERE_API_KEY = savedHereApiKey;
  }
}

/**
 * Runs a whole (stubbed -- withTestServer clears STRIPE_SECRET_KEY)
 * purchase through the server: POST /billing/checkout-session, then POST
 * /billing/complete with the session id the stub put in its redirect URL,
 * the way the checkout page does after Stripe sends the browser back.
 * Returns the session response and the completion response.
 */
async function stubPurchase(port, { email, addressCount }) {
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/billing/checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, addressCount, returnUrl: 'http://localhost:5173/#/checkout' }),
  });
  const session = await sessionResponse.json();
  const response = await fetch(`http://127.0.0.1:${port}/billing/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.sessionId }),
  });
  return { session, response };
}

module.exports = {
  makeDb,
  stubPurchase,
  makeFixtureDsn,
  makeUsersDb,
  withTestServer,
  createTestDatabase,
  parseZipEntries,
  ADMIN_DSN,
  SOCKET_HOST,
};
