const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// GET /admin/address-inference/review: the owner dashboard's Training data
// tab. Same ADMIN_PASSCODE gate as /admin/transactions.

async function seedPredictions(pool) {
  await pool.query('CREATE SCHEMA address_inference');
  await pool.query(`
    CREATE TABLE address_inference.ml_predictions (
      region_id TEXT, town TEXT, method TEXT, address_id TEXT, address_number INTEGER, street TEXT,
      e911_lat DOUBLE PRECISION, e911_lon DOUBLE PRECISION, m0_lat DOUBLE PRECISION, m0_lon DOUBLE PRECISION,
      true_building TEXT, picked_building TEXT, picked_lat DOUBLE PRECISION, picked_lon DOUBLE PRECISION,
      error_m DOUBLE PRECISION, status TEXT, candidates INTEGER, run_date DATE)`);
  await pool.query(`
    INSERT INTO address_inference.ml_predictions VALUES
      ('me', 'Freeport', 'ml', 'a1', 12, 'MAIN ST', 43.857, -70.103, 43.8571, -70.1031, 'b1', 'b1', 43.857, -70.103, 4.2, 'right', 30, '2026-11-03'),
      ('me', 'Freeport', 'ml', 'a2', 14, 'MAIN ST', 43.858, -70.103, 43.8581, -70.1031, 'b2', 'b3', 43.859, -70.103, 111.4, 'wrong', 30, '2026-11-03'),
      ('me', 'Freeport', 'ml_order', 'a1', 12, 'MAIN ST', 43.857, -70.103, 43.8571, -70.1031, 'b1', 'b1', 43.857, -70.103, 4.2, 'right', 30, '2026-11-03'),
      ('me', 'Freeport', 'ml_order', 'a2', 14, 'MAIN ST', 43.858, -70.103, 43.8581, -70.1031, 'b2', 'b2', 43.858, -70.103, 3.0, 'right', 30, '2026-11-03')`);
  await pool.query(`CREATE TABLE address_inference.e911_point_details (site_uid TEXT, town TEXT, unit TEXT, placement TEXT)`);
  await pool.query(`INSERT INTO address_inference.e911_point_details VALUES ('a2', 'Freeport', 'Unit 14', 'Structure - Interior Unit')`);
  await pool.query(`
    CREATE TABLE address_inference.structures (source_id TEXT, sqmeters DOUBLE PRECISION, geom geometry(MultiPolygon, 4326))`);
  await pool.query(`
    INSERT INTO address_inference.structures VALUES
      ('b1', 140.4, ST_GeomFromText('MULTIPOLYGON(((-70.1031 43.8569, -70.1029 43.8569, -70.1029 43.8571, -70.1031 43.8571, -70.1031 43.8569)))', 4326)),
      ('far', 90, ST_GeomFromText('MULTIPOLYGON(((-69.0 44.0, -68.99 44.0, -68.99 44.01, -69.0 44.0)))', 4326))`);
}

async function withPasscode(fn) {
  process.env.ADMIN_PASSCODE = 'correct-horse';
  try {
    await fn();
  } finally {
    delete process.env.ADMIN_PASSCODE;
  }
}

test('GET /admin/address-inference/review rejects a missing or wrong passcode', () =>
  withTestServer(
    async ({ port }) => {
      assert.equal((await fetch(`http://127.0.0.1:${port}/admin/address-inference/review`)).status, 401);
      await withPasscode(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/admin/address-inference/review?passcode=wrong`);
        assert.equal(response.status, 401);
      });
    },
    { seedStreets: false }
  ));

test('GET /admin/address-inference/review is a 404 where the experiment never ran', () =>
  withTestServer(
    async ({ port }) =>
      withPasscode(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/admin/address-inference/review?passcode=correct-horse`);
        assert.equal(response.status, 404);
        assert.match((await response.json()).error, /--save/);
      }),
    { seedStreets: false }
  ));

test('GET /admin/address-inference/review returns each address with its true and picked building', () =>
  withTestServer(
    async ({ port }) =>
      withPasscode(async () => {
        const response = await fetch(
          `http://127.0.0.1:${port}/admin/address-inference/review?passcode=correct-horse&town=freeport&method=ml`
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.town, 'Freeport');
        assert.equal(body.method, 'ml');
        assert.deepEqual(body.summary, { right: 1, wrong: 1 });
        assert.deepEqual(body.towns, [{ region: 'me', town: 'Freeport', runDate: '2026-11-03', addresses: 2 }]);
        const wrong = body.addresses.find((a) => a.id === 'a2');
        assert.equal(wrong.trueBuilding, 'b2');
        assert.equal(wrong.pickedBuilding, 'b3');
        assert.equal(wrong.errorMeters, 111);
        assert.deepEqual(wrong.picked, { latitude: 43.859, longitude: -70.103 });
        // Only footprints near the town's addresses.
        assert.deepEqual(body.buildings.features.map((f) => f.properties), [{ id: 'b1', sqmeters: 140 }]);
        assert.equal(body.buildings.features[0].geometry.type, 'MultiPolygon');
      }),
    { seedStreets: false, geoOptions: { postgis: true }, geoSeed: seedPredictions }
  ));

test('GET /admin/address-inference/review defaults to ML + road order and flags changed picks', () =>
  withTestServer(
    async ({ port }) =>
      withPasscode(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/admin/address-inference/review?passcode=correct-horse`);
        const body = await response.json();
        assert.equal(body.method, 'ml_order');
        assert.deepEqual(body.summary, { right: 2 });
        const a2 = body.addresses.find((a) => a.id === 'a2');
        assert.equal(a2.changedFromMl, true);
        assert.equal(a2.mlStatus, 'wrong');
        assert.equal(a2.unit, 'Unit 14');
        assert.equal(a2.placement, 'Structure - Interior Unit');
        assert.equal(body.addresses.find((a) => a.id === 'a1').unit, null);
        assert.equal(body.addresses.find((a) => a.id === 'a1').changedFromMl, false);
      }),
    { seedStreets: false, geoOptions: { postgis: true }, geoSeed: seedPredictions }
  ));
