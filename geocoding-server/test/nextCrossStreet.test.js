const test = require('node:test');
const assert = require('node:assert/strict');

const { findNextCrossStreet } = require('../src/nextCrossStreet');
const { ValidationError, NotFoundError, OutOfRangeError } = require('../src/errors');
const { createTestDatabase } = require('./helpers');
const { seedNextCrossStreetFixture, DRIVER, HAZARD } = require('./nextCrossStreetFixture');

async function makeFixtureDb() {
  const { pool, drop } = await createTestDatabase({ postgis: false });
  await seedNextCrossStreetFixture(pool);
  pool.close = drop;
  return pool;
}

test('findNextCrossStreet picks Elm St -- the street between the driver and the hazard', async () => {
  const db = await makeFixtureDb();
  const result = await findNextCrossStreet(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
    hazardRoadway: HAZARD.roadway,
  });
  assert.equal(result.fullname, 'Elm St');
  assert.ok(result.distanceFromDriverMeters > 200 && result.distanceFromDriverMeters < 250);
  await db.close();
});

test('findNextCrossStreet never returns Oak St -- it crosses behind the driver, not toward the hazard', async () => {
  const db = await makeFixtureDb();
  // Run several times conceptually covered by the single deterministic
  // winner check above; this test asserts the negative directly instead.
  const result = await findNextCrossStreet(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
    hazardRoadway: HAZARD.roadway,
  });
  assert.notEqual(result.fullname, 'Oak St');
  await db.close();
});

test('findNextCrossStreet excludes the hazard road by name, case-insensitively', async () => {
  const db = await makeFixtureDb();
  const result = await findNextCrossStreet(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
    hazardRoadway: 'MAIN ST',
  });
  assert.equal(result.fullname, 'Elm St');
  await db.close();
});

test('findNextCrossStreet documented v1 limitation: with no hazardRoadway, the hazard road itself can win', async () => {
  const db = await makeFixtureDb();
  const result = await findNextCrossStreet(db, {
    driverLatitude: DRIVER.latitude,
    driverLongitude: DRIVER.longitude,
    hazardLatitude: HAZARD.latitude,
    hazardLongitude: HAZARD.longitude,
    hazardRoadway: null,
  });
  assert.equal(result.fullname, 'Main St');
  await db.close();
});

test('findNextCrossStreet throws OutOfRangeError when the hazard is too far from the driver', async () => {
  const db = await makeFixtureDb();
  await assert.rejects(
    () =>
      findNextCrossStreet(db, {
        driverLatitude: 43.0,
        driverLongitude: -70.0,
        hazardLatitude: 43.03, // ~3.3km away
        hazardLongitude: -70.0,
        hazardRoadway: null,
      }),
    OutOfRangeError
  );
  await db.close();
});

test('findNextCrossStreet throws NotFoundError when nothing is nearby', async () => {
  const db = await makeFixtureDb();
  await assert.rejects(
    () =>
      findNextCrossStreet(db, {
        driverLatitude: 0.001,
        driverLongitude: 0.0,
        hazardLatitude: 0.007,
        hazardLongitude: 0.0,
        hazardRoadway: null,
      }),
    NotFoundError
  );
  await db.close();
});

test('findNextCrossStreet throws ValidationError for invalid coordinates', async () => {
  const db = await makeFixtureDb();
  await assert.rejects(
    () =>
      findNextCrossStreet(db, {
        driverLatitude: 200,
        driverLongitude: -70.0,
        hazardLatitude: 43.008,
        hazardLongitude: -70.0,
        hazardRoadway: null,
      }),
    ValidationError
  );
  await assert.rejects(
    () =>
      findNextCrossStreet(db, {
        driverLatitude: 'a',
        driverLongitude: -70.0,
        hazardLatitude: 43.008,
        hazardLongitude: -70.0,
        hazardRoadway: null,
      }),
    ValidationError
  );
  await db.close();
});
