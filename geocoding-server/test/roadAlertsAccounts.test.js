const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureRoadAlertsAccountsTable,
  registerAccount,
  checkAccess,
  updateDigestOptIn,
} = require('../src/roadAlertsAccounts');
const { NotFoundError, UnauthorizedError } = require('../src/errors');
const { makeUsersDb } = require('./helpers');

test('registerAccount creates a fresh row with a real service key on first call', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsAccountsTable(db);

  const account = await registerAccount(db, 'alice@example.com');
  assert.equal(account.email, 'alice@example.com');
  assert.match(account.service_key, /^mk_[0-9a-f]{48}$/);
  assert.equal(account.created, true);
  assert.ok(account.registered_at);
  assert.equal(account.digest_opt_in, false);

  await db.close();
});

test('updateDigestOptIn flips the digest opt-in flag for an account', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsAccountsTable(db);
  await registerAccount(db, 'alice@example.com');

  const optedIn = await updateDigestOptIn(db, 'alice@example.com', true);
  assert.equal(optedIn.digest_opt_in, true);

  const optedOut = await updateDigestOptIn(db, 'alice@example.com', false);
  assert.equal(optedOut.digest_opt_in, false);

  await db.close();
});

test('registerAccount is idempotent -- a second call returns the same key', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsAccountsTable(db);

  const first = await registerAccount(db, 'alice@example.com');
  const second = await registerAccount(db, 'alice@example.com');

  assert.equal(second.service_key, first.service_key);
  assert.deepEqual(second.registered_at, first.registered_at);
  assert.equal(second.created, false);

  await db.close();
});

test('checkAccess returns the account for a matching email+key pair', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsAccountsTable(db);

  const created = await registerAccount(db, 'alice@example.com');
  const account = await checkAccess(db, 'alice@example.com', created.service_key);
  assert.equal(account.email, 'alice@example.com');

  await db.close();
});

test('checkAccess throws NotFoundError for an unregistered email', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsAccountsTable(db);

  await assert.rejects(() => checkAccess(db, 'nobody@example.com', 'mk_whatever'), NotFoundError);

  await db.close();
});

test('checkAccess throws UnauthorizedError for a wrong or missing key on a known email', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsAccountsTable(db);

  await registerAccount(db, 'alice@example.com');
  await assert.rejects(() => checkAccess(db, 'alice@example.com', 'mk_wrong'), UnauthorizedError);
  await assert.rejects(() => checkAccess(db, 'alice@example.com', ''), UnauthorizedError);
  await assert.rejects(() => checkAccess(db, 'alice@example.com', undefined), UnauthorizedError);

  await db.close();
});
