const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const { registerAccount, ensureRoadAlertsAccountsTable } = require('../src/roadAlertsAccounts');
const { ensureWeightedPointsTable, recordWeightedPointPing } = require('../src/weightedPoints');
const {
  ensureRoadAlertsPushTables,
  saveSubscription,
  upsertLivePosition,
  hasAlreadySentPush,
  recordPushSent,
  getSubscriptionsForAccount,
} = require('../src/roadAlertsPush');
const { runPushCheckOnce } = require('../scripts/road-alerts-push-worker');

async function setUp(pool) {
  await ensureRoadAlertsAccountsTable(pool);
  await ensureWeightedPointsTable(pool);
  await ensureRoadAlertsPushTables(pool);
}

test('runPushCheckOnce sends a push for a serious hazard matched to an active driver', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/abc', p256dh: 'k', auth: 'a' });
  // A routine point 2km north of the driver's live position.
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  // A third ping to clear the 'balanced' tier's minPingsToQualify (3), so
  // this point actually qualifies as a weighted point (see weightedPoints.js).
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const sent = [];
  const fakeWebPush = {
    sendNotification: async (subscription, payload) => {
      sent.push({ subscription, payload });
    },
  };
  const fakeGetRoadSignals = async () => ({
    signals: [
      {
        id: 'signal-1',
        severity: 'serious',
        latitude: 43.668, // ~1km along the path north -- inside the corridor
        longitude: -70.2568,
        speech: { brief: 'Serious hazard ahead' },
      },
    ],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscription.endpoint, 'https://push.example/abc');
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), true);
  await pool.close();
});

test('runPushCheckOnce does not re-send a hazard already recorded as sent', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/abc', p256dh: 'k', auth: 'a' });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  // A third ping to clear the 'balanced' tier's minPingsToQualify (3), so
  // this point actually qualifies as a weighted point (see weightedPoints.js).
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });
  await recordPushSent(pool, account.id, 'signal-1');

  const sent = [];
  const fakeWebPush = { sendNotification: async (subscription, payload) => sent.push({ subscription, payload }) };
  const fakeGetRoadSignals = async () => ({
    signals: [{ id: 'signal-1', severity: 'serious', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } }],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  assert.equal(sent.length, 0);
  await pool.close();
});

test('runPushCheckOnce deletes a subscription on a 410 Gone response', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/expired', p256dh: 'k', auth: 'a' });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  // A third ping to clear the 'balanced' tier's minPingsToQualify (3), so
  // this point actually qualifies as a weighted point (see weightedPoints.js).
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const fakeWebPush = {
    sendNotification: async () => {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    },
  };
  const fakeGetRoadSignals = async () => ({
    signals: [{ id: 'signal-1', severity: 'serious', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } }],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  const remaining = await getSubscriptionsForAccount(pool, account.id);
  assert.equal(remaining.length, 0);
  await pool.close();
});

test('runPushCheckOnce does not record as sent when every send fails with a non-410 error', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/flaky', p256dh: 'k', auth: 'a' });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  // A third ping to clear the 'balanced' tier's minPingsToQualify (3), so
  // this point actually qualifies as a weighted point (see weightedPoints.js).
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const fakeWebPush = {
    sendNotification: async () => {
      const err = new Error('Service Unavailable');
      err.statusCode = 503;
      throw err;
    },
  };
  const fakeGetRoadSignals = async () => ({
    signals: [{ id: 'signal-1', severity: 'serious', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } }],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), false);
  await pool.close();
});

test('runPushCheckOnce does not record as sent when the matched account has zero push subscriptions', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  // Deliberately no saveSubscription call -- an account can have a live
  // position (from POST /road-signals/live-position) with no push
  // subscription ever registered (POST /road-signals/push-subscribe is a
  // separate, independent endpoint).
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const sent = [];
  const fakeWebPush = { sendNotification: async (subscription, payload) => sent.push({ subscription, payload }) };
  const fakeGetRoadSignals = async () => ({
    signals: [{ id: 'signal-1', severity: 'serious', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } }],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  assert.equal(sent.length, 0);
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), false);
  await pool.close();
});

test('runPushCheckOnce does not send a push for a proximity-severity hazard', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/abc', p256dh: 'k', auth: 'a' });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  // A third ping to clear the 'balanced' tier's minPingsToQualify (3), so
  // this point actually qualifies as a weighted point (see weightedPoints.js).
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const sent = [];
  const fakeWebPush = { sendNotification: async (subscription, payload) => sent.push({ subscription, payload }) };
  const fakeGetRoadSignals = async () => ({
    signals: [
      { id: 'signal-1', severity: 'proximity', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } },
    ],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  assert.equal(sent.length, 0);
  await pool.close();
});

test('runPushCheckOnce deletes a stale (>10 minute) live-position row and clears its push-sent dedup history', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/abc', p256dh: 'k', auth: 'a' });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });
  await recordPushSent(pool, account.id, 'signal-1');
  await pool.query(
    `UPDATE road_alerts_live_positions SET updated_at = now() - interval '11 minutes' WHERE account_id = $1`,
    [account.id]
  );

  const fakeWebPush = { sendNotification: async () => {} };
  const fakeGetRoadSignals = async () => ({
    signals: [],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  const { rows } = await pool.query('SELECT * FROM road_alerts_live_positions WHERE account_id = $1', [account.id]);
  assert.equal(rows.length, 0);
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), false);
  await pool.close();
});

test('a getWeightedPoints throw for one account does not prevent a second, healthy account from still getting its push', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const failingAccount = await registerAccount(pool, 'failing@example.com');
  const healthyAccount = await registerAccount(pool, 'healthy@example.com');
  await saveSubscription(pool, failingAccount.id, {
    endpoint: 'https://push.example/failing',
    p256dh: 'k',
    auth: 'a',
  });
  await saveSubscription(pool, healthyAccount.id, {
    endpoint: 'https://push.example/healthy',
    p256dh: 'k',
    auth: 'a',
  });
  await upsertLivePosition(pool, failingAccount.id, { latitude: 43.6591, longitude: -70.2568, heading: null });
  await upsertLivePosition(pool, healthyAccount.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const sent = [];
  const fakeWebPush = { sendNotification: async (subscription, payload) => sent.push({ subscription, payload }) };
  const fakeGetRoadSignals = async () => ({
    signals: [{ id: 'signal-1', severity: 'serious', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } }],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });
  // Bypasses the real weightedPoints.js qualification logic entirely --
  // this test only cares that one account's thrown error doesn't abort the
  // loop before the other account is even reached.
  const fakeGetWeightedPoints = async (_pool, email) => {
    if (email === 'failing@example.com') throw new Error('boom');
    return [{ latitude: 43.677, longitude: -70.2568, weight: 10 }];
  };

  await runPushCheckOnce(pool, {
    getRoadSignals: fakeGetRoadSignals,
    webPush: fakeWebPush,
    getWeightedPoints: fakeGetWeightedPoints,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscription.endpoint, 'https://push.example/healthy');
  await pool.close();
});
