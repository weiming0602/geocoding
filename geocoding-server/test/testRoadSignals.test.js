const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureTestRoadSignalsTable,
  addTestRoadSignal,
  getTestRoadSignals,
  clearTestRoadSignals,
} = require('../src/testRoadSignals');
const { ValidationError } = require('../src/errors');
const { makeUsersDb } = require('./helpers');

test('addTestRoadSignal stores the row and getTestRoadSignals returns it shaped as a RoadSignal', async () => {
  const db = await makeUsersDb();
  await ensureTestRoadSignalsTable(db);

  await addTestRoadSignal(db, 'alice@example.com', {
    latitude: 43.9106,
    longitude: -69.8148,
    roadway: 'Route 1',
    description: 'Fake test hazard',
    severity: 'serious',
  });

  const signals = await getTestRoadSignals(db, 'alice@example.com');
  assert.equal(signals.length, 1);
  const signal = signals[0];
  assert.equal(signal.type, 'traffic_hazard');
  assert.equal(signal.latitude, 43.9106);
  assert.equal(signal.longitude, -69.8148);
  assert.equal(signal.roadway, 'Route 1');
  assert.equal(signal.description, 'Fake test hazard');
  assert.equal(signal.severity, 'serious');
  assert.match(signal.id, /^test-\d+$/);
  assert.ok(signal.createdAt);
  assert.ok(signal.speech.brief);

  await db.close();
});

test('addTestRoadSignal defaults severity to need_to_know and allows omitting roadway/description', async () => {
  const db = await makeUsersDb();
  await ensureTestRoadSignalsTable(db);

  await addTestRoadSignal(db, 'alice@example.com', { latitude: 43.9, longitude: -69.8 });

  const [signal] = await getTestRoadSignals(db, 'alice@example.com');
  assert.equal(signal.severity, 'need_to_know');
  assert.equal(signal.roadway, null);
  assert.equal(signal.description, null);

  await db.close();
});

test('addTestRoadSignal rejects non-numeric coordinates and an invalid severity', async () => {
  const db = await makeUsersDb();
  await ensureTestRoadSignalsTable(db);

  await assert.rejects(
    () => addTestRoadSignal(db, 'alice@example.com', { latitude: NaN, longitude: -70 }),
    ValidationError
  );
  await assert.rejects(
    () => addTestRoadSignal(db, 'alice@example.com', { latitude: 43, longitude: 'nope' }),
    ValidationError
  );
  await assert.rejects(
    () => addTestRoadSignal(db, 'alice@example.com', { latitude: 43, longitude: -70, severity: 'catastrophic' }),
    ValidationError
  );

  await db.close();
});

test('getTestRoadSignals only returns signals for the given account', async () => {
  const db = await makeUsersDb();
  await ensureTestRoadSignalsTable(db);

  await addTestRoadSignal(db, 'alice@example.com', { latitude: 43.9, longitude: -69.8 });
  await addTestRoadSignal(db, 'alice@example.com', { latitude: 44.0, longitude: -69.7 });
  await addTestRoadSignal(db, 'bob@example.com', { latitude: 45.0, longitude: -68.0 });

  assert.equal((await getTestRoadSignals(db, 'alice@example.com')).length, 2);
  assert.equal((await getTestRoadSignals(db, 'bob@example.com')).length, 1);

  await db.close();
});

test("clearTestRoadSignals removes only the given account's signals and reports the count", async () => {
  const db = await makeUsersDb();
  await ensureTestRoadSignalsTable(db);

  await addTestRoadSignal(db, 'alice@example.com', { latitude: 43.9, longitude: -69.8 });
  await addTestRoadSignal(db, 'alice@example.com', { latitude: 44.0, longitude: -69.7 });
  await addTestRoadSignal(db, 'bob@example.com', { latitude: 45.0, longitude: -68.0 });

  const deleted = await clearTestRoadSignals(db, 'alice@example.com');
  assert.equal(deleted, 2);

  assert.deepEqual(await getTestRoadSignals(db, 'alice@example.com'), []);
  assert.equal((await getTestRoadSignals(db, 'bob@example.com')).length, 1);

  await db.close();
});
