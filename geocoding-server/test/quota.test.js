const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser, getUser } = require('../src/users');
const { checkQuota, useQuota } = require('../src/quota');
const { NotFoundError, QuotaExceededError, UnauthorizedError } = require('../src/errors');
const { makeUsersDb } = require('./helpers');

test('checkQuota throws NotFoundError for an email with no subscription', async () => {
  const db = await makeUsersDb();
  await assert.rejects(() => checkQuota(db, 'nobody@example.com', 'mk_whatever', 100), NotFoundError);
  await db.close();
});

test('checkQuota throws UnauthorizedError when the service key does not match', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 10000);
  await assert.rejects(
    () => checkQuota(db, 'alice@example.com', 'mk_wrong', 100),
    UnauthorizedError
  );
  await db.close();
});

test('checkQuota passes when the request fits in remaining quota', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 10000);
  const user = await checkQuota(db, 'alice@example.com', created.service_key, 9999);
  assert.equal(user.tier, 10000);
  await db.close();
});

test('checkQuota throws QuotaExceededError when the request exceeds remaining quota', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 5000);
  await assert.rejects(
    () => checkQuota(db, 'alice@example.com', created.service_key, 5001),
    QuotaExceededError
  );
  await db.close();
});

test('checkQuota accounts for usage already recorded this period', async () => {
  const db = await makeUsersDb();
  const created = await upsertUser(db, 'alice@example.com', 5000);
  await useQuota(db, 'alice@example.com', 4800);

  await assert.rejects(
    () => checkQuota(db, 'alice@example.com', created.service_key, 300),
    QuotaExceededError
  ); // only 200 left
  const user = await checkQuota(db, 'alice@example.com', created.service_key, 200); // exactly the remainder is fine
  assert.equal(user.used_this_period, 4800);
  await db.close();
});

test('useQuota increments usage', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 5000);
  await useQuota(db, 'alice@example.com', 123);
  assert.equal((await getUser(db, 'alice@example.com')).used_this_period, 123);
  await db.close();
});

test('checkQuota accepts an empty service key only when ALLOW_TEST_EMPTY_SERVICE_KEY is set', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 5000);
  const saved = process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;

  try {
    // Off by default (and explicitly off here) -- an empty key is still rejected.
    delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    await assert.rejects(() => checkQuota(db, 'alice@example.com', '', 100), UnauthorizedError);
    await assert.rejects(() => checkQuota(db, 'alice@example.com', undefined, 100), UnauthorizedError);

    process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = 'true';
    const user = await checkQuota(db, 'alice@example.com', '', 100);
    assert.equal(user.email, 'alice@example.com');

    // The flag only waives an EMPTY key -- a wrong one is still rejected,
    // so it can't be used to guess/brute-force a real key.
    await assert.rejects(
      () => checkQuota(db, 'alice@example.com', 'mk_wrong', 100),
      UnauthorizedError
    );
  } finally {
    if (saved !== undefined) process.env.ALLOW_TEST_EMPTY_SERVICE_KEY = saved;
    else delete process.env.ALLOW_TEST_EMPTY_SERVICE_KEY;
    await db.close();
  }
});
