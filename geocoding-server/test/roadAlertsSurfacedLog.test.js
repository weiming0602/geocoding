const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureRoadAlertsSurfacedLogTable,
  insertSurfacedAlert,
  getPendingAlertsGroupedByEmail,
  deleteSurfacedAlerts,
} = require('../src/roadAlertsSurfacedLog');
const { makeUsersDb } = require('./helpers');

const SAMPLE_SIGNAL = {
  id: 'ME26-002841',
  roadway: 'I-95',
  severity: 'proximity',
  latitude: 43.168363,
  longitude: -70.653171,
  source: 'New England 511',
  network: 'Maine',
  speech: { brief: 'Traffic on I-95.', average: 'Slow traffic on I-95 south.', deep: 'Slow traffic on I-95 southbound near York.' },
};

test('insertSurfacedAlert stores the signal fields relevant to a digest', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsSurfacedLogTable(db);

  const row = await insertSurfacedAlert(db, 'alice@example.com', SAMPLE_SIGNAL);
  assert.equal(row.email, 'alice@example.com');
  assert.equal(row.signal_id, SAMPLE_SIGNAL.id);
  assert.equal(row.roadway, 'I-95');
  assert.equal(row.severity, 'proximity');
  assert.equal(row.description, 'Traffic on I-95.');
  assert.ok(row.surfaced_at);

  await db.close();
});

test('insertSurfacedAlert rejects a signal with no id', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsSurfacedLogTable(db);

  await assert.rejects(() => insertSurfacedAlert(db, 'alice@example.com', { severity: 'serious' }));

  await db.close();
});

test('getPendingAlertsGroupedByEmail groups pending rows by account, oldest first', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsSurfacedLogTable(db);

  await insertSurfacedAlert(db, 'alice@example.com', SAMPLE_SIGNAL);
  await insertSurfacedAlert(db, 'alice@example.com', { ...SAMPLE_SIGNAL, id: 'ME26-002842' });
  await insertSurfacedAlert(db, 'bob@example.com', SAMPLE_SIGNAL);

  const grouped = await getPendingAlertsGroupedByEmail(db);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get('alice@example.com').length, 2);
  assert.equal(grouped.get('bob@example.com').length, 1);

  await db.close();
});

test('deleteSurfacedAlerts removes only the given rows', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsSurfacedLogTable(db);

  const first = await insertSurfacedAlert(db, 'alice@example.com', SAMPLE_SIGNAL);
  const second = await insertSurfacedAlert(db, 'alice@example.com', { ...SAMPLE_SIGNAL, id: 'ME26-002842' });

  const deleted = await deleteSurfacedAlerts(db, [first.id]);
  assert.equal(deleted, 1);

  const grouped = await getPendingAlertsGroupedByEmail(db);
  assert.equal(grouped.get('alice@example.com').length, 1);
  assert.equal(grouped.get('alice@example.com')[0].id, second.id);

  await db.close();
});
