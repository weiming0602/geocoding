#!/usr/bin/env node
// Long-running process (not a systemd-timer-triggered one-shot, unlike
// scripts/road-alerts-digest.js) -- runs its own setInterval every 60s
// (matches roadSignals.js's NETWORK_CACHE_TTL_MS), since it may be the
// only thing still requesting hazard data once every browser tab is
// closed. See ops/geocoding-road-alerts-push-worker.service and
// docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
//
//   node scripts/road-alerts-push-worker.js

require('dotenv').config();

const { Pool } = require('../src/db');
const { getRoadSignals: realGetRoadSignals } = require('../src/roadSignals');
const { getWeightedPoints: realGetWeightedPoints } = require('../src/weightedPoints');
const { ensureWeightedPointsTable } = require('../src/weightedPoints');
const { ensureRoadAlertsAccountsTable } = require('../src/roadAlertsAccounts');
const {
  ensureRoadAlertsPushTables,
  getActiveLivePositions,
  hasAlreadySentPush,
  recordPushSent,
  clearPushSentForAccount,
  getSubscriptionsForAccount,
  deleteSubscriptionByEndpoint,
} = require('../src/roadAlertsPush');
const { findAlertsForWeightedPoints, shouldStronglyAlert } = require('../src/roadAlertsMatching');
const { isPushConfigured, configureWebPush } = require('../src/pushKeys');

const CHECK_INTERVAL_MS = 60000;

/**
 * One pass over every active driver: fetch their nearby hazards and
 * weighted points, run the same route-approach matching the client does,
 * and push for any new serious/need_to_know match. `deps` lets tests
 * inject fakes for getRoadSignals/getWeightedPoints/webPush without a
 * real network call or real push service.
 */
async function runPushCheckOnce(pool, deps = {}) {
  const getRoadSignals = deps.getRoadSignals || realGetRoadSignals;
  const getWeightedPoints = deps.getWeightedPoints || realGetWeightedPoints;
  const webPush = deps.webPush || require('web-push');

  // Sweep expired live-position rows before matching -- a driver whose tab
  // was killed rather than cleanly Stopped otherwise leaves their row (and
  // dedup history) behind forever, since getActiveLivePositions only
  // *filters* stale rows out of its SELECT rather than deleting them. Same
  // "delete + clear dedup together" pairing as the DELETE
  // /road-signals/live-position handler uses on a clean Stop.
  const { rows: expired } = await pool.query(
    `DELETE FROM road_alerts_live_positions
     WHERE updated_at <= now() - interval '10 minutes' RETURNING account_id`
  );
  for (const row of expired) {
    await clearPushSentForAccount(pool, row.account_id);
  }

  const activePositions = await getActiveLivePositions(pool);

  for (const position of activePositions) {
    const user = { latitude: position.latitude, longitude: position.longitude };

    let signals;
    try {
      const result = await getRoadSignals({ latitude: user.latitude, longitude: user.longitude, radiusMeters: 10000 });
      signals = result.signals;
    } catch (err) {
      console.error(`Failed to fetch hazards for account ${position.account_id}:`, err.message);
      continue;
    }

    // Everything below is a second, separate try/catch (distinct from the
    // getRoadSignals one above, which already has its own continue) so a
    // persistent per-account issue here (a bad weighted-point row, a
    // malformed subscription, etc.) can't abort the whole tick and starve
    // every other driver -- getActiveLivePositions has no ORDER BY, so
    // that would nondeterministically deprive different accounts each run.
    try {
      const weightedPoints = await getWeightedPoints(pool, position.email);
      const alerts = findAlertsForWeightedPoints(user, weightedPoints, signals);
      const strongAlerts = alerts.filter((alert) => shouldStronglyAlert(alert.signal.severity));

      for (const alert of strongAlerts) {
        if (await hasAlreadySentPush(pool, position.account_id, alert.signal.id)) continue;

        const subscriptions = await getSubscriptionsForAccount(pool, position.account_id);
        const payload = JSON.stringify({
          title: `${alert.signal.severity === 'serious' ? 'Serious' : 'Need to know'} road alert`,
          body: alert.signal.speech.brief,
        });

        let anySucceeded = false;
        for (const subscription of subscriptions) {
          try {
            await webPush.sendNotification(
              { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
              payload
            );
            anySucceeded = true;
          } catch (err) {
            if (err.statusCode === 410) {
              await deleteSubscriptionByEndpoint(pool, subscription.endpoint);
            } else {
              console.error(`Push send failed for account ${position.account_id}:`, err.message);
            }
          }
        }

        // Only mark as sent once something was actually delivered -- zero
        // subscriptions (never pushed at all) or every subscription failing
        // with a transient (non-410) error must not permanently suppress a
        // serious/need_to_know alert with no retry on the next tick.
        if (anySucceeded) {
          await recordPushSent(pool, position.account_id, alert.signal.id);
        }
      }
    } catch (err) {
      console.error(`Push matching/send failed for account ${position.account_id}:`, err.message);
    }
  }
}

async function main() {
  const USERS_DSN = process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';
  const pool = new Pool({ connectionString: USERS_DSN });
  await ensureRoadAlertsAccountsTable(pool);
  await ensureWeightedPointsTable(pool);
  await ensureRoadAlertsPushTables(pool);

  if (!isPushConfigured()) {
    console.warn('VAPID keys not configured -- road-alerts-push-worker will run but never send anything.');
  } else {
    configureWebPush(require('web-push'));
  }

  console.log(`road-alerts-push-worker started, checking every ${CHECK_INTERVAL_MS}ms`);
  setInterval(() => {
    runPushCheckOnce(pool).catch((err) => console.error('Push check failed:', err));
  }, CHECK_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { runPushCheckOnce };
