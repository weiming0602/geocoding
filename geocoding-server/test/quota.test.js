const test = require('node:test');
const assert = require('node:assert/strict');

const { openUsersDb, upsertUser, getUser } = require('../src/users');
const { checkQuota, useQuota } = require('../src/quota');
const { NotFoundError, QuotaExceededError } = require('../src/errors');

test('checkQuota throws NotFoundError for an email with no subscription', () => {
  const db = openUsersDb(':memory:');
  assert.throws(() => checkQuota(db, 'nobody@example.com', 100), NotFoundError);
  db.close();
});

test('checkQuota passes when the request fits in remaining quota', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'alice@example.com', 10000);
  const user = checkQuota(db, 'alice@example.com', 9999);
  assert.equal(user.tier, 10000);
  db.close();
});

test('checkQuota throws QuotaExceededError when the request exceeds remaining quota', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'alice@example.com', 5000);
  assert.throws(() => checkQuota(db, 'alice@example.com', 5001), QuotaExceededError);
  db.close();
});

test('checkQuota accounts for usage already recorded this period', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'alice@example.com', 5000);
  useQuota(db, 'alice@example.com', 4800);

  assert.throws(() => checkQuota(db, 'alice@example.com', 300), QuotaExceededError); // only 200 left
  const user = checkQuota(db, 'alice@example.com', 200); // exactly the remainder is fine
  assert.equal(user.used_this_period, 4800);
  db.close();
});

test('useQuota increments usage', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'alice@example.com', 5000);
  useQuota(db, 'alice@example.com', 123);
  assert.equal(getUser(db, 'alice@example.com').used_this_period, 123);
  db.close();
});
