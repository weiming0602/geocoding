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
async function createTestDatabase({ postgis = true, pgrouting = false } = {}) {
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
      maxy DOUBLE PRECISION
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
  `);

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

  const rows = [
    {
      id: 12, tlid: '78056932', fullname: 'Pequawket Trl', lfromadd: '988', ltoadd: '998',
      rfromadd: '979', rtoadd: '991', zipl: '04091', zipr: '04091', state: 'Maine', state_abbr: 'ME',
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
      id: 14, tlid: '78012506', fullname: 'Pequawket Trl', lfromadd: '700', ltoadd: '738',
      rfromadd: '701', rtoadd: '721', zipl: '04091', zipr: '04091', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.79 43.83, -70.795 43.835)',
    },
    // Same fullname+zip as id=12/14 but in a different state, to test that
    // state disambiguates when everything else collides.
    {
      id: 99, tlid: '99999999', fullname: 'Pequawket Trl', lfromadd: '100', ltoadd: '198',
      rfromadd: '101', rtoadd: '199', zipl: '04091', zipr: '04091', state: 'New Hampshire', state_abbr: 'NH',
      geometry: 'LINESTRING (-71.0 43.9, -71.01 43.91)',
    },
    // A real-world shape (e.g. "Greely Rd" in the actual dataset): zipl and
    // zipr differ, since the street runs along a ZIP boundary.
    {
      id: 50, tlid: '50000000', fullname: 'Greely Rd', lfromadd: '201', ltoadd: '291',
      rfromadd: '200', rtoadd: '292', zipl: '04021', zipr: '04097', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.2 43.9, -70.21 43.91)',
    },
  ];

  for (const row of rows) {
    const [minx, miny, maxx, maxy] = bboxOf(row.geometry);
    await pool.query(
      `INSERT INTO streets
         (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr,
          geometry, minx, miny, maxx, maxy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
 */
async function withTestServer(callback, { seedStreets = true, geoOptions = {}, geoSeed } = {}) {
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
  delete require.cache[require.resolve('../src/server')];
  const server = require('../src/server');
  const httpServer = server.app.listen(0);
  const usersDb = await server.usersDbPromise;

  // billing.js's captureOrder() should always exercise the deliberate
  // stub in tests, never a real PayPal API call -- but dotenv (loaded by
  // server.js, just above) picks up whatever real .env a developer
  // happens to have locally. billing.js reads these at call time, not at
  // require time, so clearing them *after* requiring server.js (dotenv
  // has already run) still forces the stub for every request handled
  // during this test. Restored afterward.
  const savedPaypalClientId = process.env.PAYPAL_CLIENT_ID;
  const savedPaypalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;

  // Same rationale as the PayPal vars just above, for
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
    if (savedPaypalClientId !== undefined) process.env.PAYPAL_CLIENT_ID = savedPaypalClientId;
    if (savedPaypalClientSecret !== undefined) process.env.PAYPAL_CLIENT_SECRET = savedPaypalClientSecret;
    if (savedResendApiKey !== undefined) process.env.RESEND_API_KEY = savedResendApiKey;
    if (savedResendFromEmail !== undefined) process.env.RESEND_FROM_EMAIL = savedResendFromEmail;
    if (savedAllowTestEmptyServiceKey !== undefined)
      process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = savedAllowTestEmptyServiceKey;
    if (savedAllowTestWeightedPoints !== undefined)
      process.env.ALLOW_TEST_WEIGHTED_POINTS = savedAllowTestWeightedPoints;
  }
}

module.exports = {
  makeDb,
  makeFixtureDsn,
  makeUsersDb,
  withTestServer,
  createTestDatabase,
  parseZipEntries,
  ADMIN_DSN,
  SOCKET_HOST,
};
