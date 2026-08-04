const { Pool } = require('./db');

const CREATE_USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  tier INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  used_this_period INTEGER NOT NULL DEFAULT 0
);
`;

/** Opens (creating the table if needed) the users/subscriptions database. */
async function openUsersDb(dsn) {
  const pool = new Pool({ connectionString: dsn });
  await pool.query(CREATE_USERS_TABLE_SQL);
  return pool;
}

/** First-of-month date string (e.g. "2026-07-01") for the current billing period. */
function currentPeriodStart(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

async function getUser(db, email) {
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0];
}

/** Manual admin operation: creates a user or updates an existing one's tier. */
async function upsertUser(db, email, tier) {
  const { rows } = await db.query(
    `INSERT INTO users (email, tier, period_start, used_this_period)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (email) DO UPDATE SET tier = excluded.tier
     RETURNING *`,
    [email, tier, currentPeriodStart()]
  );
  return rows[0];
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
    `INSERT INTO users (email, tier, period_start, used_this_period)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (email) DO UPDATE SET tier = users.tier + excluded.tier
     RETURNING *`,
    [email, amount, currentPeriodStart()]
  );
  return rows[0];
}

module.exports = {
  openUsersDb,
  currentPeriodStart,
  getUser,
  upsertUser,
  ensureCurrentPeriod,
  recordUsage,
  addToTier,
};
