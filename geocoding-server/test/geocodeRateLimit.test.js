const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const {
  ensureGeocodeRateLimitsTable,
  checkRateLimit,
  deleteOldRateLimits,
} = require('../src/geocodeRateLimit');
const { RateLimitError } = require('../src/errors');

// makeUsersDb() (unlike withTestServer, see helpers.js) does NOT clear
// RESEND_API_KEY/RESEND_FROM_EMAIL -- checkRateLimit can call
// sendRateLimitBlockedNotification internally once an IP is blocked, so
// without this, a test here could attempt a real Resend network call if
// the developer's own .env happens to have those set. Exact same
// problem, exact same fix as transactionsDigest.test.js's own
// withStubbedEmail helper.
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

test('checkRateLimit allows a fresh IP under the threshold', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(db, '203.0.113.1'); // does not throw
    }

    const { rows } = await db.query(
      'SELECT window_count, total_count, blocked_at FROM geocode_rate_limits WHERE ip_address = $1',
      ['203.0.113.1']
    );
    assert.equal(rows[0].window_count, 10);
    assert.equal(rows[0].total_count, 10);
    assert.equal(rows[0].blocked_at, null);

    await db.close();
  }));

test('checkRateLimit blocks on the 11th request within a minute and notifies the owner', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(db, '203.0.113.2');
    }

    await assert.rejects(() => checkRateLimit(db, '203.0.113.2'), RateLimitError);

    const { rows } = await db.query('SELECT blocked_at, total_count FROM geocode_rate_limits WHERE ip_address = $1', [
      '203.0.113.2',
    ]);
    assert.ok(rows[0].blocked_at);
    assert.equal(rows[0].total_count, 11);

    await db.close();
  }));

test('checkRateLimit keeps rejecting every further request that same day, and keeps counting them', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 11; i++) {
      await checkRateLimit(db, '203.0.113.3').catch(() => {});
    }

    await assert.rejects(() => checkRateLimit(db, '203.0.113.3'), RateLimitError);
    await assert.rejects(() => checkRateLimit(db, '203.0.113.3'), RateLimitError);

    // The upsert always runs before the blocked_at check (see
    // checkRateLimit's own comment) -- total_count keeps accumulating for
    // a persistent abuser even after blocking, which is a deliberate
    // choice: it tells the owner how severe the abuse actually was, and a
    // single always-atomic upsert (no separate "is this IP already
    // blocked" read first) means no race window between that read and the
    // write. 11 initial + 2 more rejected = 13.
    const { rows } = await db.query('SELECT total_count, blocked_at FROM geocode_rate_limits WHERE ip_address = $1', [
      '203.0.113.3',
    ]);
    assert.equal(rows[0].total_count, 13);
    assert.ok(rows[0].blocked_at);

    await db.close();
  }));

test('checkRateLimit resets the window after 60 seconds, not the day-long block', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(db, '203.0.113.4');
    }
    // Simulate the window having started over a minute ago, same pattern
    // roadAlertsPushWorker.test.js uses for its own staleness tests.
    await db.query(
      `UPDATE geocode_rate_limits SET window_started_at = now() - interval '2 minutes' WHERE ip_address = $1`,
      ['203.0.113.4']
    );

    await checkRateLimit(db, '203.0.113.4'); // does not throw -- window rolled over

    const { rows } = await db.query('SELECT window_count, total_count FROM geocode_rate_limits WHERE ip_address = $1', [
      '203.0.113.4',
    ]);
    assert.equal(rows[0].window_count, 1); // reset, not 11
    assert.equal(rows[0].total_count, 11); // total keeps accumulating regardless

    await db.close();
  }));

test('deleteOldRateLimits only deletes rows older than the given number of days', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    await checkRateLimit(db, '203.0.113.6'); // today
    await db.query(
      `INSERT INTO geocode_rate_limits (ip_address, date, window_started_at, window_count, total_count)
       VALUES ('203.0.113.7', CURRENT_DATE - 100, now() - interval '100 days', 1, 1)`
    );

    const deletedCount = await deleteOldRateLimits(db, 90);
    assert.equal(deletedCount, 1);

    const { rows } = await db.query('SELECT ip_address FROM geocode_rate_limits ORDER BY ip_address');
    assert.deepEqual(rows.map((r) => r.ip_address), ['203.0.113.6']);

    await db.close();
  }));
