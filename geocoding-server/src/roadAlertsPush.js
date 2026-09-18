const CREATE_PUSH_SUBSCRIPTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES road_alerts_accounts(id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, endpoint)
);
`;

// account_id as the PRIMARY KEY (not a surrogate id) is what makes "one
// row per account, always overwritten" structural rather than a
// convention to remember -- see docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
const CREATE_LIVE_POSITIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_live_positions (
  account_id BIGINT PRIMARY KEY REFERENCES road_alerts_accounts(id),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  heading DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const CREATE_PUSH_SENT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_push_sent (
  account_id BIGINT NOT NULL REFERENCES road_alerts_accounts(id),
  signal_id TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, signal_id)
);
`;

async function ensureRoadAlertsPushTables(pool) {
  await pool.query(CREATE_PUSH_SUBSCRIPTIONS_TABLE_SQL);
  await pool.query(CREATE_LIVE_POSITIONS_TABLE_SQL);
  await pool.query(CREATE_PUSH_SENT_TABLE_SQL);
}

/** Idempotent -- re-subscribing with the same endpoint (e.g. after a browser data clear) is a no-op, not a duplicate row. */
async function saveSubscription(pool, accountId, { endpoint, p256dh, auth }) {
  await pool.query(
    `INSERT INTO road_alerts_push_subscriptions (account_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, endpoint) DO NOTHING`,
    [accountId, endpoint, p256dh, auth]
  );
}

async function getSubscriptionsForAccount(pool, accountId) {
  const { rows } = await pool.query('SELECT * FROM road_alerts_push_subscriptions WHERE account_id = $1', [
    accountId,
  ]);
  return rows;
}

/** Called when a push send comes back 410 Gone -- the browser unsubscribed, unrecoverable. */
async function deleteSubscriptionByEndpoint(pool, endpoint) {
  await pool.query('DELETE FROM road_alerts_push_subscriptions WHERE endpoint = $1', [endpoint]);
}

/** Upsert, not insert -- account_id is the primary key, so this always overwrites the single existing row for this account. */
async function upsertLivePosition(pool, accountId, { latitude, longitude, heading }) {
  await pool.query(
    `INSERT INTO road_alerts_live_positions (account_id, latitude, longitude, heading, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (account_id) DO UPDATE
       SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, heading = EXCLUDED.heading, updated_at = now()`,
    [accountId, latitude, longitude, heading ?? null]
  );
}

async function deleteLivePosition(pool, accountId) {
  await pool.query('DELETE FROM road_alerts_live_positions WHERE account_id = $1', [accountId]);
}

/** Only rows updated in the last 10 minutes -- an older row is treated as a driver who never called Stop cleanly. Joined against road_alerts_accounts for the email the worker needs to look up weighted points. */
async function getActiveLivePositions(pool) {
  const { rows } = await pool.query(
    `SELECT lp.account_id, a.email, lp.latitude, lp.longitude, lp.heading, lp.updated_at
     FROM road_alerts_live_positions lp
     JOIN road_alerts_accounts a ON a.id = lp.account_id
     WHERE lp.updated_at > now() - interval '10 minutes'`
  );
  return rows;
}

async function hasAlreadySentPush(pool, accountId, signalId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM road_alerts_push_sent WHERE account_id = $1 AND signal_id = $2',
    [accountId, signalId]
  );
  return rows.length > 0;
}

async function recordPushSent(pool, accountId, signalId) {
  await pool.query(
    `INSERT INTO road_alerts_push_sent (account_id, signal_id) VALUES ($1, $2)
     ON CONFLICT (account_id, signal_id) DO NOTHING`,
    [accountId, signalId]
  );
}

/** Clears this account's dedup history -- called when its live-position row is deleted/expired, so a later drive starts clean and the same hazard can alert again. */
async function clearPushSentForAccount(pool, accountId) {
  await pool.query('DELETE FROM road_alerts_push_sent WHERE account_id = $1', [accountId]);
}

module.exports = {
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
};
