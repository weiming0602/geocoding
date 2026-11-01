const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser, getUser, recordUsage } = require('../src/users');
const { reserveQuota, releaseQuota } = require('../src/quota');
const { NotFoundError, QuotaExceededError, UnauthorizedError } = require('../src/errors');
const { makeUsersDb } = require('./helpers');

test('reserveQuota throws NotFoundError for an email with no subscription', async () => {
  const db = await makeUsersDb();
  await assert.rejects(() => reserveQuota(db, 'nobody@example.com', 'mk_whatever', 100), NotFoundError);
  await db.close();
});

test('reserveQuota throws UnauthorizedError when the service key does not match', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 10000);
  await assert.rejects(
    () => reserveQuota(db, 'alice@example.com', 'mk_wrong', 100),
    UnauthorizedError
  );
  await db.close();
});

test('reserveQuota passes when the request fits, and charges it immediately', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 10000);
  const user = await reserveQuota(db, 'alice@example.com', created.service_key, 9999);
  assert.equal(user.tier, 10000);
  assert.equal(user.used_this_period, 9999);
  assert.equal((await getUser(db, 'alice@example.com')).used_this_period, 9999);
  await db.close();
});

test('reserveQuota throws QuotaExceededError when the request exceeds remaining quota', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 5000);
  await assert.rejects(
    () => reserveQuota(db, 'alice@example.com', created.service_key, 5001),
    QuotaExceededError
  );
  await db.close();
});

test('reserveQuota accounts for usage already recorded this period', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 5000);
  await recordUsage(db, 'alice@example.com', 4800);

  await assert.rejects(
    () => reserveQuota(db, 'alice@example.com', created.service_key, 300),
    QuotaExceededError
  ); // only 200 left -- and the rejected request charged nothing
  assert.equal((await getUser(db, 'alice@example.com')).used_this_period, 4800);
  const user = await reserveQuota(db, 'alice@example.com', created.service_key, 200); // exactly the remainder is fine
  assert.equal(user.used_this_period, 5000);
  await db.close();
});

test('releaseQuota gives a reservation back', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 5000);
  const reservation = await reserveQuota(db, 'alice@example.com', created.service_key, 123);
  await releaseQuota(db, reservation, 123);
  assert.equal((await getUser(db, 'alice@example.com')).used_this_period, 0);
  await db.close();
});

test('releaseQuota is a no-op once the period has rolled over', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 5000);
  const reservation = await reserveQuota(db, 'alice@example.com', created.service_key, 100);
  // A new month started (and some of it was used) while the request ran.
  await db.query("UPDATE users SET period_start = '2999-01-01', used_this_period = 40 WHERE email = $1", [
    'alice@example.com',
  ]);
  await releaseQuota(db, reservation, 100);
  assert.equal((await getUser(db, 'alice@example.com')).used_this_period, 40);
  await db.close();
});

test('reserveQuota rolls a stale period over before reserving', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 100);
  await db.query("UPDATE users SET period_start = '2000-01-01', used_this_period = 100 WHERE email = $1", [
    'alice@example.com',
  ]);
  const user = await reserveQuota(db, 'alice@example.com', created.service_key, 30);
  assert.equal(user.used_this_period, 30);
  assert.notEqual(user.period_start, '2000-01-01');
  await db.close();
});

test('concurrent reserveQuota calls can never spend more than the plan', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 10);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () => reserveQuota(db, 'alice@example.com', created.service_key, 10))
  );
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  for (const o of outcomes.filter((o) => o.status === 'rejected')) {
    assert.ok(o.reason instanceof QuotaExceededError);
  }
  assert.equal((await getUser(db, 'alice@example.com')).used_this_period, 10);
  await db.close();
});

test('reserveQuota accepts an empty service key only when ALLOW_TEST_EMPTY_SERVICE_KEY is set', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 5000);
  const saved = process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;

  try {
    // Off by default (and explicitly off here) -- an empty key is still rejected.
    delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    await assert.rejects(() => reserveQuota(db, 'alice@example.com', '', 100), UnauthorizedError);
    await assert.rejects(() => reserveQuota(db, 'alice@example.com', undefined, 100), UnauthorizedError);

    process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = 'true';
    const user = await reserveQuota(db, 'alice@example.com', '', 100);
    assert.equal(user.email, 'alice@example.com');

    // The flag only waives an EMPTY key -- a wrong one is still rejected,
    // so it can't be used to guess/brute-force a real key.
    await assert.rejects(
      () => reserveQuota(db, 'alice@example.com', 'mk_wrong', 100),
      UnauthorizedError
    );
  } finally {
    if (saved !== undefined) process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = saved;
    else delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    await db.close();
  }
});
