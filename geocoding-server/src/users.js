const crypto = require('crypto');

const { Pool } = require('./db');

const CREATE_USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  tier INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  used_this_period INTEGER NOT NULL DEFAULT 0,
  service_key TEXT UNIQUE
);
`;

// Postgres treats ADD COLUMN IF NOT EXISTS as a no-op when the column's
// already there, so this is safe to run every time openUsersDb() does --
// existing databases (created before service_key existed) pick it up
// without a separate migration step.
const ADD_SERVICE_KEY_COLUMN_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_key TEXT UNIQUE;
`;

/** Opens (creating the table if needed) the users/subscriptions database. */
async function openUsersDb(dsn) {
  const pool = new Pool({ connectionString: dsn });
  await pool.query(CREATE_USERS_TABLE_SQL);
  await pool.query(ADD_SERVICE_KEY_COLUMN_SQL);
  return pool;
}

/**
 * A new account's service key -- presented alongside its email on every
 * batch-geocoding request (see quota.js's checkQuota) so that knowing an
 * account's email alone isn't enough to spend its quota. Generated once,
 * on first purchase/creation; upsertUser() and addToTier() never
 * regenerate an existing account's key on top-up, since that would break
 * anything already using it.
 */
function generateServiceKey() {
  return `mk_${crypto.randomBytes(24).toString('hex')}`;
}

/** First-of-month date string (e.g. "2026-07-01") for the current billing period. */
function currentPeriodStart(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

async function getUser(db, email) {
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0];
}

/**
 * Manual admin operation: creates a user or updates an existing one's
 * tier. A fresh service_key is only ever used on the INSERT branch (the
 * ON CONFLICT update doesn't touch it), so an existing account keeps
 * whatever key it already has.
 */
async function upsertUser(db, email, tier) {
  const { rows } = await db.query(
    `INSERT INTO users (email, tier, period_start, used_this_period, service_key)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (email) DO UPDATE SET tier = excluded.tier
     RETURNING *`,
    [email, tier, currentPeriodStart(), generateServiceKey()]
  );
  return rows[0];
}

/** Returns the user row if email+serviceKey match an existing account, else null. */
async function verifyServiceKey(db, email, serviceKey) {
  const user = await getUser(db, email);
  if (!user || !serviceKey || user.service_key !== serviceKey) return null;
  return user;
}

/**
 * Resets usage to 0 if the user's tracked period has rolled into a new
 * calendar month. Returns the (possibly updated) user row.
 */
async function ensureCurrentPeriod(db, user) {
  const period = currentPeriodStart();
  if (user.period_start === period) {
    return user;
  }
  const { rows } = await db.query(
    'UPDATE users SET period_start = $1, used_this_period = 0 WHERE email = $2 RETURNING *',
    [period, user.email]
  );
  return rows[0];
}

async function recordUsage(db, email, count) {
  await db.query('UPDATE users SET used_this_period = used_this_period + $1 WHERE email = $2', [
    count,
    email,
  ]);
}

/**
 * Adds `amount` to a user's tier -- creating them with that tier if new,
 * topping up an existing one otherwise. Used by the billing purchase flow
 * to grant additional monthly quota; unlike upsertUser() this never
 * overwrites an existing tier, only adds to it.
 */
async function addToTier(db, email, amount) {
  const { rows } = await db.query(
    `INSERT INTO users (email, tier, period_start, used_this_period, service_key)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (email) DO UPDATE SET tier = users.tier + excluded.tier
     RETURNING *`,
    [email, amount, currentPeriodStart(), generateServiceKey()]
  );
  return rows[0];
}

module.exports = {
  openUsersDb,
  currentPeriodStart,
  getUser,
  upsertUser,
  verifyServiceKey,
  ensureCurrentPeriod,
  recordUsage,
  addToTier,
};
