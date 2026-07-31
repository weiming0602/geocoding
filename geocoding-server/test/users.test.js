const test = require('node:test');
const assert = require('node:assert/strict');

const {
  openUsersDb,
  currentPeriodStart,
  getUser,
  upsertUser,
  ensureCurrentPeriod,
  recordUsage,
} = require('../src/users');

test('currentPeriodStart formats the first of the month', () => {
  assert.equal(currentPeriodStart(new Date(2026, 6, 15)), '2026-07-01'); // July (0-indexed month 6)
  assert.equal(currentPeriodStart(new Date(2026, 0, 31)), '2026-01-01');
});

test('upsertUser creates a new user with zero usage', () => {
  const db = openUsersDb(':memory:');
  const user = upsertUser(db, 'alice@example.com', 10000);
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.tier, 10000);
  assert.equal(user.used_this_period, 0);
  db.close();
});

test('upsertUser on an existing email updates the tier without resetting usage', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'alice@example.com', 5000);
  recordUsage(db, 'alice@example.com', 1200);

  const updated = upsertUser(db, 'alice@example.com', 20000);
  assert.equal(updated.tier, 20000);
  assert.equal(updated.used_this_period, 1200);
  db.close();
});

test('getUser returns undefined for an unknown email', () => {
  const db = openUsersDb(':memory:');
  assert.equal(getUser(db, 'nobody@example.com'), undefined);
  db.close();
});

test('recordUsage accumulates within the same period', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'bob@example.com', 5000);
  recordUsage(db, 'bob@example.com', 300);
  recordUsage(db, 'bob@example.com', 450);
  assert.equal(getUser(db, 'bob@example.com').used_this_period, 750);
  db.close();
});

test('ensureCurrentPeriod resets usage when the tracked period is stale', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'carol@example.com', 5000);
  recordUsage(db, 'carol@example.com', 4000);

  // Simulate a user whose period_start is from last month.
  db.prepare('UPDATE users SET period_start = ? WHERE email = ?').run(
    '2020-01-01',
    'carol@example.com'
  );

  const refreshed = ensureCurrentPeriod(db, getUser(db, 'carol@example.com'));
  assert.equal(refreshed.used_this_period, 0);
  assert.equal(refreshed.period_start, currentPeriodStart());
  db.close();
});

test('ensureCurrentPeriod is a no-op within the same period', () => {
  const db = openUsersDb(':memory:');
  upsertUser(db, 'dave@example.com', 5000);
  recordUsage(db, 'dave@example.com', 2000);

  const user = getUser(db, 'dave@example.com');
  const refreshed = ensureCurrentPeriod(db, user);
  assert.equal(refreshed.used_this_period, 2000);
  db.close();
});
