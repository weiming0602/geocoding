const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser, getUser } = require('../src/users');
const { checkQuota, useQuota } = require('../src/quota');
const { NotFoundError, QuotaExceededError } = require('../src/errors');
const { makeUsersDb } = require('./helpers');

test('checkQuota throws NotFoundError for an email with no subscription', async () => {
  const db = await makeUsersDb();
  await assert.rejects(() => checkQuota(db, 'nobody@example.com', 100), NotFoundError);
  await db.close();
});

test('checkQuota passes when the request fits in remaining quota', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 10000);
  const user = await checkQuota(db, 'alice@example.com', 9999);
  assert.equal(user.tier, 10000);
  await db.close();
});

test('checkQuota throws QuotaExceededError when the request exceeds remaining quota', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 5000);
  await assert.rejects(() => checkQuota(db, 'alice@example.com', 5001), QuotaExceededError);
  await db.close();
});

test('checkQuota accounts for usage already recorded this period', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 5000);
  await useQuota(db, 'alice@example.com', 4800);

  await assert.rejects(() => checkQuota(db, 'alice@example.com', 300), QuotaExceededError); // only 200 left
  const user = await checkQuota(db, 'alice@example.com', 200); // exactly the remainder is fine
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
