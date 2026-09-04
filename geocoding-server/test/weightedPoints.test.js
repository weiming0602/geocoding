const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const {
  ensureWeightedPointsTable,
  recordWeightedPointPing,
  getWeightedPoints,
} = require('../src/weightedPoints');

const EMAIL = 'alice@example.com';

/** Row count regardless of qualification -- getWeightedPoints only ever
 * returns qualified rows, so an unqualified-row assertion has to go
 * straight at the table. */
async function rawRowCount(db, email = EMAIL) {
  const { rows } = await db.query('SELECT count(*) FROM road_alerts_weighted_points WHERE email = $1', [email]);
  return Number(rows[0].count);
}

test('a single ping creates a tracked row, but is not yet qualified', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    const point = await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    assert.equal(point.latitude, 43.9);
    assert.equal(await rawRowCount(db), 1);

    // Not qualified yet (needs MIN_PINGS_TO_QUALIFY within the window) --
    // getWeightedPoints must not surface it.
    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 0);
  } finally {
    await db.close();
  }
});

test('a point qualifies once pinged enough times within the window, and is then returned', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9004, longitude: -69.8 }); // ~50m away, merges
    let points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 0, 'two pings should not be enough to qualify yet');

    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9004, longitude: -69.8 }); // third ping
    points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 1, 'three pings within the window should qualify the point');
    assert.ok(Number(points[0].weight) > 2.9, 'weight should be close to 3 after three near-instant pings');
  } finally {
    await db.close();
  }
});

test('pings spread across an expired window never accumulate toward qualifying', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    // Backdate the window as if the first ping happened 10 days ago --
    // past QUALIFYING_WINDOW_DAYS (7).
    await db.query(
      `UPDATE road_alerts_weighted_points SET window_started_at = now() - interval '10 days' WHERE email = $1`,
      [EMAIL]
    );
    // This ping should start a *fresh* window (count resets to 1), not extend the stale one.
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9004, longitude: -69.8 });

    const { rows } = await db.query(
      'SELECT window_ping_count, qualified_at FROM road_alerts_weighted_points WHERE email = $1',
      [EMAIL]
    );
    assert.equal(rows[0].window_ping_count, 1, 'the expired window should have reset the count');
    assert.equal(rows[0].qualified_at, null);
  } finally {
    await db.close();
  }
});

test('a ping far from an existing point creates a separate row', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    // Roughly 100km away -- nowhere close to MATCH_RADIUS_METERS.
    await recordWeightedPointPing(db, EMAIL, { latitude: 44.8, longitude: -68.8 });

    assert.equal(await rawRowCount(db), 2);
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
    assert.equal(await rawRowCount(db), 0);
  } finally {
    await db.close();
  }
});

test('getWeightedPoints decays a qualified point\'s weight based on time since the last ping', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    // Ping three times to qualify.
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });

    const beforeDecay = await getWeightedPoints(db, EMAIL);
    const weightAtQualification = Number(beforeDecay[0].weight);

    // Backdate last_pinged_at by 30 days to simulate a route not driven in a while.
    await db.query(
      `UPDATE road_alerts_weighted_points SET last_pinged_at = now() - interval '30 days' WHERE email = $1`,
      [EMAIL]
    );

    const afterDecay = await getWeightedPoints(db, EMAIL);
    assert.equal(afterDecay.length, 1);
    assert.ok(Number(afterDecay[0].weight) < weightAtQualification, 'a stale point should have decayed');
  } finally {
    await db.close();
  }
});

test('getWeightedPoints returns qualified points sorted by weight, heaviest first', async () => {
  const db = await makeUsersDb();
  try {
    await ensureWeightedPointsTable(db);
    // Point A: exactly 3 pings (just qualifies).
    for (let i = 0; i < 3; i++) {
      await recordWeightedPointPing(db, EMAIL, { latitude: 43.9, longitude: -69.8 });
    }
    // Point B: 5 pings (should end up heavier than A).
    for (let i = 0; i < 5; i++) {
      await recordWeightedPointPing(db, EMAIL, { latitude: 44.8, longitude: -68.8 });
    }

    const points = await getWeightedPoints(db, EMAIL);
    assert.equal(points.length, 2);
    assert.ok(Number(points[0].weight) > Number(points[1].weight));
    assert.equal(points[0].latitude, 44.8);
  } finally {
    await db.close();
  }
});
