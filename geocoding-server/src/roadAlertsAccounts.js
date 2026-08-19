const { generateServiceKey } = require('./users');
const { NotFoundError, UnauthorizedError } = require('./errors');

const CREATE_ROAD_ALERTS_ACCOUNTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_accounts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  service_key TEXT UNIQUE NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Postgres treats ADD COLUMN IF NOT EXISTS as a no-op when the column's
// already there, so this is safe to run every time
// ensureRoadAlertsAccountsTable() does -- existing databases (created
// before digest_opt_in existed) pick it up without a separate migration
// step, same pattern as users.js's ADD_SERVICE_KEY_COLUMN_SQL. Defaults
// to false: the daily email digest is opt-in, never automatic.
const ADD_DIGEST_OPT_IN_COLUMN_SQL = `
ALTER TABLE road_alerts_accounts ADD COLUMN IF NOT EXISTS digest_opt_in BOOLEAN NOT NULL DEFAULT false;
`;

// Nullable -- existing accounts have none yet, and there's no
// uniqueness constraint: v1 has no identity-verification posture for
// Road Alerts, so a duplicate display name is an acceptable
// simplification rather than something worth a real username-registry
// system for. Shown alongside a statement (see roadAlertsStatements.js)
// instead of the account's email.
const ADD_USERNAME_COLUMN_SQL = `
ALTER TABLE road_alerts_accounts ADD COLUMN IF NOT EXISTS username TEXT;
`;

/** Creates the road_alerts_accounts table if it doesn't already exist. */
async function ensureRoadAlertsAccountsTable(pool) {
  await pool.query(CREATE_ROAD_ALERTS_ACCOUNTS_TABLE_SQL);
  await pool.query(ADD_DIGEST_OPT_IN_COLUMN_SQL);
  await pool.query(ADD_USERNAME_COLUMN_SQL);
}

async function getAccount(pool, email) {
  const { rows } = await pool.query('SELECT * FROM road_alerts_accounts WHERE email = $1', [email]);
  return rows[0];
}

/**
 * Registers a Road Alerts account -- idempotent: an email that's already
 * registered gets its existing row back untouched (`created: false`),
 * never a new service_key. This deliberately doubles as a "forgot my
 * key" recovery path -- there's no separate recovery flow anywhere in
 * this app (see users.js's service-key comments), so re-registering
 * with the same email is how a user gets their existing key re-emailed
 * to them.
 *
 * `ON CONFLICT DO NOTHING` + a fallback SELECT (rather than an upsert
 * that regenerates the key) is what makes this safe to call repeatedly --
 * still race-safe under concurrent requests for the same new email: if
 * another request's INSERT wins, this one's RETURNING comes back empty
 * and the follow-up SELECT picks up the winner's row.
 *
 * Road Alerts is free for every registered account right now, no trial
 * clock, no charge -- see docs/ROAD_ALERTS_DESIGN.md and the product
 * decision behind this: watch real usage first, decide on billing later
 * rather than building trial-abuse defenses (device binding, a card on
 * file, etc.) against a monetization scheme that doesn't exist yet.
 */
async function registerAccount(pool, email) {
  const inserted = await pool.query(
    `INSERT INTO road_alerts_accounts (email, service_key)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [email, generateServiceKey()]
  );
  if (inserted.rows[0]) {
    return { ...inserted.rows[0], created: true };
  }
  const existing = await getAccount(pool, email);
  return { ...existing, created: false };
}

/**
 * Looks up a Road Alerts account by email and verifies the service key
 * matches, mirroring quota.js's checkQuota lookup-then-verify shape.
 * Throws NotFoundError for an unknown email, UnauthorizedError for a
 * wrong/missing key.
 */
async function checkAccess(pool, email, serviceKey) {
  const account = await getAccount(pool, email);
  if (!account) {
    throw new NotFoundError(`no Road Alerts account found for ${email}`);
  }
  if (!serviceKey || account.service_key !== serviceKey) {
    throw new UnauthorizedError('service key is missing or does not match this account');
  }
  return account;
}

/** Updates an account's opt-in flag for the daily email digest. */
async function updateDigestOptIn(pool, email, digestOptIn) {
  const { rows } = await pool.query(
    `UPDATE road_alerts_accounts SET digest_opt_in = $1 WHERE email = $2 RETURNING *`,
    [digestOptIn, email]
  );
  return rows[0];
}

/** Updates an account's display name, shown alongside anything they post. */
async function updateUsername(pool, email, username) {
  const { rows } = await pool.query(
    `UPDATE road_alerts_accounts SET username = $1 WHERE email = $2 RETURNING *`,
    [username, email]
  );
  return rows[0];
}

module.exports = {
  ensureRoadAlertsAccountsTable,
  getAccount,
  registerAccount,
  checkAccess,
  updateDigestOptIn,
  updateUsername,
};
