const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const { registerAccount, ensureRoadAlertsAccountsTable } = require('../src/roadAlertsAccounts');
const {
  ensureRoadAlertsPushTables,
  saveSubscription,
  getSubscriptionsForAccount,
  deleteSubscriptionByEndpoint,
  upsertLivePosition,
  deleteLivePosition,
  getActiveLivePositions,
  hasAlreadySentPush,
  recordPushSent,
  clearPushSentForAccount,
} = require('../src/roadAlertsPush');

async function setUp(pool) {
  await ensureRoadAlertsAccountsTable(pool);
  await ensureRoadAlertsPushTables(pool);
  return registerAccount(pool, 'driver@example.com');
}

test('saveSubscription is idempotent for the same account+endpoint', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  const subscription = { endpoint: 'https://push.example/abc', p256dh: 'key1', auth: 'auth1' };

  await saveSubscription(pool, account.id, subscription);
  await saveSubscription(pool, account.id, subscription);

  const rows = await getSubscriptionsForAccount(pool, account.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, subscription.endpoint);
  await pool.close();
});

test('deleteSubscriptionByEndpoint removes only that subscription', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/a', p256dh: 'k', auth: 'a' });
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/b', p256dh: 'k', auth: 'a' });

  await deleteSubscriptionByEndpoint(pool, 'https://push.example/a');

  const rows = await getSubscriptionsForAccount(pool, account.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, 'https://push.example/b');
  await pool.close();
});

test('upsertLivePosition overwrites in place, never inserts a second row', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);

  await upsertLivePosition(pool, account.id, { latitude: 43.6, longitude: -70.2, heading: 90 });
  await upsertLivePosition(pool, account.id, { latitude: 43.7, longitude: -70.3, heading: 180 });

  const active = await getActiveLivePositions(pool);
  const mine = active.filter((row) => row.account_id === account.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].latitude, 43.7);
  assert.equal(mine[0].email, 'driver@example.com');
  await pool.close();
});

test('deleteLivePosition removes the row so it no longer appears as active', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  await upsertLivePosition(pool, account.id, { latitude: 43.6, longitude: -70.2, heading: null });

  await deleteLivePosition(pool, account.id);

  const active = await getActiveLivePositions(pool);
  assert.equal(active.filter((row) => row.account_id === account.id).length, 0);
  await pool.close();
});

test('a stale live position (older than 10 minutes) is excluded from getActiveLivePositions', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  await upsertLivePosition(pool, account.id, { latitude: 43.6, longitude: -70.2, heading: null });
  await pool.query(
    `UPDATE road_alerts_live_positions SET updated_at = now() - interval '11 minutes' WHERE account_id = $1`,
    [account.id]
  );

  const active = await getActiveLivePositions(pool);
  assert.equal(active.filter((row) => row.account_id === account.id).length, 0);
  await pool.close();
});

test('hasAlreadySentPush / recordPushSent / clearPushSentForAccount', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);

  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), false);

  await recordPushSent(pool, account.id, 'signal-1');
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), true);
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-2'), false);

  await clearPushSentForAccount(pool, account.id);
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), false);
  await pool.close();
});
