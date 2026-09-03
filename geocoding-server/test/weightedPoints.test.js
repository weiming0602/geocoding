const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const {
  ensureWeightedPointsTable,
  recordWeightedPointPing,
  getWeightedPoints,
} = require('../src/weightedPoints');

const EMAIL = 'alice@example.com';

test('recordWeightedPointPing creates a new point on the first ping', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    const point = await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    assert.equal(point.latitude, 43.9);
    assert.equal(point.longitude, -69.8);
    assert.equal(Number(point.weight), 1);

    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 1);
  } finally {
    await db.close();
  }
});

test('a ping near an existing point merges into it instead of creating a second one', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    // ~50m away -- well within MATCH_RADIUS_METERS (150m).
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9004, longitude: -69.8 });

    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 1);
    assert.ok(Number(points[0].weight) > 1, 'weight should have grown past the first ping');
  } finally {
    await db.close();
  }
});

test('a ping far from an existing point creates a separate one', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    // Roughly 100km away -- nowhere close to MATCH_RADIUS_METERS.
    await recordWeightedPointPing(db, EMAIL, { latitude: 44.8, longitude: -68.8 });

    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 2);
  } finally {
    await db.close();
  }
});

test('an endpoint ping (trip start/end) is never recorded', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    const result = await recordWeightedPointPing(db, EMAIL, {
      latitude: 43.9,
      longitude: -69.8,
      isEndpoint: true,
    });
    assert.equal(result, null);

    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 0);
  } finally {
    await db.close();
  }
});

test('getWeightedPoints decays weight based on time since the last ping', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    // Backdate last_pinged_at by 30 days to simulate a route not driven in a while.
    await db.query(
      `UPDATE road_alerts_weighted_points SET last_pinged_at = now() - interval '30 days' WHERE email = $1`,
      [EMAIL]
    );

    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 1);
    assert.ok(Number(points[0].weight) < 1, 'a stale point should have decayed below its original weight');
  } finally {
    await db.close();
  }
});

test('getWeightedPoints returns points sorted by weight, heaviest first', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 }); // weight 1
    await recordWeightedPointPing(db, EMAIL, { latitude: 44.8, longitude: -68.8 }); // weight 1
    await recordWeightedPointPing(db, EMAIL, { latitude: 44.8, longitude: -68.8 }); // weight ~2

    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 2);
    assert.ok(Number(points[0].weight) > Number(points[1].weight));
  } finally {
    await db.close();
  }
});
