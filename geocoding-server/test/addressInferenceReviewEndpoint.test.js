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
        // suggest.py and parcels.py never ran here
        assert.deepEqual(body.suggestions, []);
        assert.deepEqual(body.parcels.features, []);
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
        // A table saved before tax_roll existed still loads.
        assert.equal(a2.taxRoll, null);
      }),
    { seedStreets: false, geoOptions: { postgis: true }, geoSeed: seedPredictions }
  ));

test('GET /admin/address-inference/review says which assessor picks the tax roll pinned', () =>
  withTestServer(
    async ({ port }) =>
      withPasscode(async () => {
        const url = `http://127.0.0.1:${port}/admin/address-inference/review?passcode=correct-horse`;
        const assessor = await (await fetch(`${url}&method=assessor`)).json();
        assert.equal(assessor.addresses.find((a) => a.id === 'a1').taxRoll, true);
        assert.equal(assessor.addresses.find((a) => a.id === 'a2').taxRoll, false);
        const order = await (await fetch(`${url}&method=ml_order`)).json();
        assert.equal(order.addresses.find((a) => a.id === 'a1').taxRoll, null);
      }),
    {
      seedStreets: false,
      geoOptions: { postgis: true },
      geoSeed: async (pool) => {
        await seedPredictions(pool);
        await pool.query('ALTER TABLE address_inference.ml_predictions ADD COLUMN tax_roll BOOLEAN');
        await pool.query(`
          INSERT INTO address_inference.ml_predictions VALUES
            ('me', 'Freeport', 'assessor', 'a1', 12, 'MAIN ST', 43.857, -70.103, 43.8571, -70.1031, 'b1', 'b1', 43.857, -70.103, 4.2, 'right', 30, '2026-11-03', true),
            ('me', 'Freeport', 'assessor', 'a2', 14, 'MAIN ST', 43.858, -70.103, 43.8581, -70.1031, 'b2', 'b2', 43.858, -70.103, 3.0, 'right', 30, '2026-11-03', false)`);
      },
    }
  ));

test('GET /admin/address-inference/review includes numbers suggested for unnumbered houses', () =>
  withTestServer(
    async ({ port }) =>
      withPasscode(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/admin/address-inference/review?passcode=correct-horse`);
        const body = await response.json();
        assert.deepEqual(body.suggestions, [
          {
            building: 'b44',
            street: 'FLYING POINT ROAD',
            number: 44,
            tier: 'second house',
            before: 42,
            after: 48,
            reason: 'between',
            latitude: 43.8575,
            longitude: -70.0716,
          },
        ]);
      }),
    {
      seedStreets: false,
      geoOptions: { postgis: true },
      geoSeed: async (pool) => {
        await seedPredictions(pool);
        await pool.query(`
          CREATE TABLE address_inference.suggested_numbers (
            region_id TEXT, town TEXT, source_id TEXT, street TEXT, number INTEGER, tier TEXT,
            before_number INTEGER, after_number INTEGER, reason TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
            run_date DATE)`);
        await pool.query(`
          INSERT INTO address_inference.suggested_numbers VALUES
            ('me', 'Freeport', 'b44', 'FLYING POINT ROAD', 44, 'second house', 42, 48, 'between', 43.8575, -70.0716, '2026-11-08'),
            ('me', 'Yarmouth', 'y1', 'MAIN ST', 3, 'unnumbered lot', 1, 5, 'between', 43.8, -70.1, '2026-11-08')`);
      },
    }
  ));

test('GET /admin/address-inference/review compares the assessor mode against ML + road order', () =>
  withTestServer(
    async ({ port }) =>
      withPasscode(async () => {
        const response = await fetch(
          `http://127.0.0.1:${port}/admin/address-inference/review?passcode=correct-horse&method=assessor`
        );
        const body = await response.json();
        assert.equal(body.method, 'assessor');
        assert.deepEqual(body.methods, ['ml_order', 'ml', 'assessor']);
        const a2 = body.addresses.find((a) => a.id === 'a2');
        assert.equal(a2.status, 'right');
        assert.equal(a2.mlStatus, 'wrong'); // ML + road order picked b3
        assert.equal(a2.changedFromMl, true);
      }),
    {
      seedStreets: false,
      geoOptions: { postgis: true },
      geoSeed: async (pool) => {
        await seedPredictions(pool);
        await pool.query(`UPDATE address_inference.ml_predictions SET picked_building = 'b3', status = 'wrong'
                          WHERE method = 'ml_order' AND address_id = 'a2'`);
        await pool.query(`
          INSERT INTO address_inference.ml_predictions VALUES
            ('me', 'Freeport', 'assessor', 'a1', 12, 'MAIN ST', 43.857, -70.103, 43.8571, -70.1031, 'b1', 'b1', 43.857, -70.103, 4.2, 'right', 30, '2026-11-08'),
            ('me', 'Freeport', 'assessor', 'a2', 14, 'MAIN ST', 43.858, -70.103, 43.8581, -70.1031, 'b2', 'b2', 43.858, -70.103, 3.0, 'right', 30, '2026-11-08')`);
      },
    }
  ));

test('GET /admin/address-inference/review includes the tax lots around the addresses', () =>
  withTestServer(
    async ({ port }) =>
      withPasscode(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/admin/address-inference/review?passcode=correct-horse`);
        const body = await response.json();
        assert.deepEqual(body.parcels.features.map((f) => f.properties), [
          { id: 'p1', lot: '17/13/2/0', address: '2 DIAMOND DRIVE', updated: '2022' },
        ]);
        assert.equal(body.parcels.features[0].geometry.type, 'MultiPolygon');
      }),
    {
      seedStreets: false,
      geoOptions: { postgis: true },
      geoSeed: async (pool) => {
        await seedPredictions(pool);
        await pool.query(`
          CREATE TABLE address_inference.parcels (
            state_fips TEXT, source TEXT, parcel_id TEXT, town TEXT, map_bk_lot TEXT, prop_loc TEXT,
            prop_num INTEGER, updated TEXT, geom geometry(MultiPolygon, 4326))`);
        await pool.query(`
          INSERT INTO address_inference.parcels VALUES
            ('23', 'me', 'p1', 'Freeport', '17/13/2/0', '2 DIAMOND DRIVE', 0, '2022',
             ST_GeomFromText('MULTIPOLYGON(((-70.1032 43.8568, -70.1028 43.8568, -70.1028 43.8572, -70.1032 43.8572, -70.1032 43.8568)))', 4326)),
            ('23', 'me', 'far', 'Durham', '1/1', '1 FAR ROAD', 0, '2022',
             ST_GeomFromText('MULTIPOLYGON(((-69.0 44.0, -68.99 44.0, -68.99 44.01, -69.0 44.0)))', 4326))`);
      },
    }
  ));
