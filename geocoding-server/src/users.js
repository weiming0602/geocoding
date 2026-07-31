const Database = require('better-sqlite3');

const CREATE_USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  tier INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  used_this_period INTEGER NOT NULL DEFAULT 0
);
`;

/** Opens (creating if needed) the users/subscriptions database. */
function openUsersDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(CREATE_USERS_TABLE_SQL);
  return db;
}

/** First-of-month date string (e.g. "2026-07-01") for the current billing period. */
function currentPeriodStart(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function getUser(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

/** Manual admin operation: creates a user or updates an existing one's tier. */
function upsertUser(db, email, tier) {
  db.prepare(
    `INSERT INTO users (email, tier, period_start, used_this_period)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET tier = excluded.tier`
  ).run(email, tier, currentPeriodStart());
  return getUser(db, email);
}

/**
 * Resets usage to 0 if the user's tracked period has rolled into a new
 * calendar month. Returns the (possibly updated) user row.
 */
function ensureCurrentPeriod(db, user) {
  const period = currentPeriodStart();
  if (user.period_start === period) {
    return user;
  }
  db.prepare('UPDATE users SET period_start = ?, used_this_period = 0 WHERE email = ?').run(
    period,
    user.email
  );
  return getUser(db, user.email);
}

function recordUsage(db, email, count) {
  db.prepare('UPDATE users SET used_this_period = used_this_period + ? WHERE email = ?').run(
    count,
    email
  );
}

module.exports = {
  openUsersDb,
  currentPeriodStart,
  getUser,
  upsertUser,
  ensureCurrentPeriod,
  recordUsage,
};
