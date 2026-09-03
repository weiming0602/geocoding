const test = require('node:test');
const assert = require('node:assert/strict');

const { insertSurfacedAlert, getPendingAlertsGroupedByEmail, ensureRoadAlertsSurfacedLogTable } =
  require('../src/roadAlertsSurfacedLog');
const { runDailyDigest } = require('../src/roadAlertsDigest');
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

// withTestServer's env-var clearing (see helpers.js) doesn't apply here --
// this test calls runDailyDigest directly, not through the HTTP server --
// so clear Resend vars explicitly to force emailDelivery.js's stub path,
// same rationale as withTestServer's own comment for why this matters.
function withStubbedEmail(fn) {
  const saved = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  };
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });
}

test('runDailyDigest sends a stubbed digest per opted-in account with pending alerts and clears them', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureRoadAlertsSurfacedLogTable(db);

    await insertSurfacedAlert(db, 'alice@example.com', SAMPLE_SIGNAL);
    await insertSurfacedAlert(db, 'alice@example.com', { ...SAMPLE_SIGNAL, id: 'ME26-002842' });
    await insertSurfacedAlert(db, 'bob@example.com', SAMPLE_SIGNAL);

    const summary = await runDailyDigest(db);
    assert.equal(summary.accountsDigested, 2);
    assert.equal(summary.emailsSent, 2);

    const grouped = await getPendingAlertsGroupedByEmail(db);
    assert.equal(grouped.size, 0);

    await db.close();
  }));

test('runDailyDigest skips an account with nothing pending', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureRoadAlertsSurfacedLogTable(db);

    const summary = await runDailyDigest(db);
    assert.equal(summary.accountsDigested, 0);
    assert.equal(summary.emailsSent, 0);

    await db.close();
  }));
