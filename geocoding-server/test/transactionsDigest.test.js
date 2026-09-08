const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureTransactionsTable,
  recordTransaction,
  getUnnotifiedTransactions,
} = require('../src/transactions');
const { runDailyTransactionsDigest } = require('../src/transactionsDigest');
const { makeUsersDb } = require('./helpers');

// withTestServer's env-var clearing (see helpers.js) doesn't apply here --
// this test calls runDailyTransactionsDigest directly, not through the
// HTTP server -- so clear Resend vars explicitly to force
// emailDelivery.js's stub path, same rationale as roadAlertsDigest.test.js.
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

test('runDailyTransactionsDigest sends a stubbed digest and marks pending transactions notified', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureTransactionsTable(db);

    await recordTransaction(db, {
      email: 'alice@example.com',
      orderId: 'ORDER-1',
      addressCount: 1000,
      priceCents: 1500,
      tier: 1000,
    });
    await recordTransaction(db, {
      email: 'bob@example.com',
      orderId: 'ORDER-2',
      addressCount: 500,
      priceCents: 900,
      tier: 500,
    });

    const summary = await runDailyTransactionsDigest(db);
    assert.equal(summary.transactionsNotified, 2);
    assert.equal(summary.emailSent, true);

    const stillPending = await getUnnotifiedTransactions(db);
    assert.equal(stillPending.length, 0);

    await db.close();
  }));

test('runDailyTransactionsDigest is a no-op with nothing pending', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureTransactionsTable(db);

    const summary = await runDailyTransactionsDigest(db);
    assert.equal(summary.transactionsNotified, 0);
    assert.equal(summary.emailSent, false);

    await db.close();
  }));
