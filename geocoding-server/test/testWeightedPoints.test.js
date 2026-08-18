const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureTestWeightedPointsTable,
  addTestWeightedPoint,
  getTestWeightedPoints,
  clearTestWeightedPoints,
} = require('../src/testWeightedPoints');
const { ValidationError } = require('../src/errors');
const { makeUsersDb } = require('./helpers');

test('addTestWeightedPoint stores and returns the row', async () => {
  const db = await makeUsersDb();
  await ensureTestWeightedPointsTable(db);

  const point = await addTestWeightedPoint(db, 'alice@example.com', {
    latitude: 43.9106,
    longitude: -69.8148,
    weight: 0.9,
    tlid: 'demo-route1-bath',
    label: 'Route 1 near Bath',
  });

  assert.equal(point.email, 'alice@example.com');
  assert.equal(point.latitude, 43.9106);
  assert.equal(point.longitude, -69.8148);
  assert.equal(point.weight, 0.9);
  assert.equal(point.tlid, 'demo-route1-bath');
  assert.equal(point.label, 'Route 1 near Bath');
  assert.ok(point.id);
  assert.ok(point.created_at);

  await db.close();
});

test('addTestWeightedPoint allows omitting tlid/label', async () => {
  const db = await makeUsersDb();
  await ensureTestWeightedPointsTable(db);

  const point = await addTestWeightedPoint(db, 'alice@example.com', {
    latitude: 43.8570,
    longitude: -70.103,
    weight: 0.5,
  });

  assert.equal(point.tlid, null);
  assert.equal(point.label, null);

  await db.close();
});

test('addTestWeightedPoint rejects non-numeric latitude/longitude/weight', async () => {
  const db = await makeUsersDb();
  await ensureTestWeightedPointsTable(db);

  await assert.rejects(
    () => addTestWeightedPoint(db, 'alice@example.com', { latitude: NaN, longitude: -70, weight: 0.5 }),
    ValidationError
  );
  await assert.rejects(
    () => addTestWeightedPoint(db, 'alice@example.com', { latitude: 43, longitude: 'nope', weight: 0.5 }),
    ValidationError
  );
  await assert.rejects(
    () => addTestWeightedPoint(db, 'alice@example.com', { latitude: 43, longitude: -70, weight: undefined }),
    ValidationError
  );

  await db.close();
});

test('getTestWeightedPoints only returns points for the given account, oldest first', async () => {
  const db = await makeUsersDb();
  await ensureTestWeightedPointsTable(db);

  await addTestWeightedPoint(db, 'alice@example.com', { latitude: 43.9, longitude: -69.8, weight: 0.9 });
  await addTestWeightedPoint(db, 'alice@example.com', { latitude: 44.0, longitude: -69.7, weight: 0.7 });
  await addTestWeightedPoint(db, 'bob@example.com', { latitude: 45.0, longitude: -68.0, weight: 0.9 });

  const alicePoints = await getTestWeightedPoints(db, 'alice@example.com');
  assert.equal(alicePoints.length, 2);
  assert.equal(alicePoints[0].weight, 0.9);
  assert.equal(alicePoints[1].weight, 0.7);

  const bobPoints = await getTestWeightedPoints(db, 'bob@example.com');
  assert.equal(bobPoints.length, 1);

  await db.close();
});

test('clearTestWeightedPoints removes only the given account\'s points and reports the count', async () => {
  const db = await makeUsersDb();
  await ensureTestWeightedPointsTable(db);

  await addTestWeightedPoint(db, 'alice@example.com', { latitude: 43.9, longitude: -69.8, weight: 0.9 });
  await addTestWeightedPoint(db, 'alice@example.com', { latitude: 44.0, longitude: -69.7, weight: 0.7 });
  await addTestWeightedPoint(db, 'bob@example.com', { latitude: 45.0, longitude: -68.0, weight: 0.9 });

  const deleted = await clearTestWeightedPoints(db, 'alice@example.com');
  assert.equal(deleted, 2);

  assert.deepEqual(await getTestWeightedPoints(db, 'alice@example.com'), []);
  assert.equal((await getTestWeightedPoints(db, 'bob@example.com')).length, 1);

  await db.close();
});
