const test = require('node:test');
const assert = require('node:assert/strict');

const {
  currentPeriodStart,
  getUser,
  upsertUser,
  ensureCurrentPeriod,
  recordUsage,
  addToTier,
} = require('../src/users');
const { makeUsersDb } = require('./helpers');

test('currentPeriodStart formats the first of the month', () => {
  assert.equal(currentPeriodStart(new Date(2026, 6, 15)), '2026-07-01'); // July (0-indexed month 6)
  assert.equal(currentPeriodStart(new Date(2026, 0, 31)), '2026-01-01');
});

test('upsertUser creates a new user with zero usage', async () => {
  const db = await makeUsersDb();
  const user = await upsertUser(db, 'alice@example.com', 10000);
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.tier, 10000);
  assert.equal(user.used_this_period, 0);
  await db.close();
});

test('upsertUser on an existing email updates the tier without resetting usage', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'alice@example.com', 5000);
  await recordUsage(db, 'alice@example.com', 1200);

  const updated = await upsertUser(db, 'alice@example.com', 20000);
  assert.equal(updated.tier, 20000);
  assert.equal(updated.used_this_period, 1200);
  await db.close();
});

test('getUser returns undefined for an unknown email', async () => {
  const db = await makeUsersDb();
  assert.equal(await getUser(db, 'nobody@example.com'), undefined);
  await db.close();
});

test('recordUsage accumulates within the same period', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'bob@example.com', 5000);
  await recordUsage(db, 'bob@example.com', 300);
  await recordUsage(db, 'bob@example.com', 450);
  assert.equal((await getUser(db, 'bob@example.com')).used_this_period, 750);
  await db.close();
});

test('ensureCurrentPeriod resets usage when the tracked period is stale', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'carol@example.com', 5000);
  await recordUsage(db, 'carol@example.com', 4000);

  // Simulate a user whose period_start is from last month.
  await db.query('UPDATE users SET period_start = $1 WHERE email = $2', [
    '2020-01-01',
    'carol@example.com',
  ]);

  const refreshed = await ensureCurrentPeriod(db, await getUser(db, 'carol@example.com'));
  assert.equal(refreshed.used_this_period, 0);
  assert.equal(refreshed.period_start, currentPeriodStart());
  await db.close();
});

test('ensureCurrentPeriod is a no-op within the same period', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'dave@example.com', 5000);
  await recordUsage(db, 'dave@example.com', 2000);

  const user = await getUser(db, 'dave@example.com');
  const refreshed = await ensureCurrentPeriod(db, user);
  assert.equal(refreshed.used_this_period, 2000);
  await db.close();
});

test('addToTier creates a new user with the given tier', async () => {
  const db = await makeUsersDb();
  const user = await addToTier(db, 'erin@example.com', 1000);
  assert.equal(user.tier, 1000);
  assert.equal(user.used_this_period, 0);
  await db.close();
});

test('addToTier tops up an existing tier without resetting usage', async () => {
  const db = await makeUsersDb();
  await upsertUser(db, 'frank@example.com', 5000);
  await recordUsage(db, 'frank@example.com', 4800);

  const updated = await addToTier(db, 'frank@example.com', 1000);
  assert.equal(updated.tier, 6000);
  assert.equal(updated.used_this_period, 4800);
  await db.close();
});
