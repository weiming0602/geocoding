const { RateLimitError } = require('./errors');
const { sendRateLimitBlockedNotification } = require('./emailDelivery');

const CREATE_RATE_LIMITS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS geocode_rate_limits (
  ip_address TEXT NOT NULL,
  date DATE NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  blocked_at TIMESTAMPTZ,
  PRIMARY KEY (ip_address, date)
);
`;

async function ensureGeocodeRateLimitsTable(pool) {
  await pool.query(CREATE_RATE_LIMITS_TABLE_SQL);
}

const WINDOW_LIMIT = 10;

/**
 * Throws RateLimitError if `ipAddress` has exceeded 10 unauthenticated
 * /geocode or /reverse-geocode requests within a ~60-second window today
 * (UTC) -- blocking it from further unauthenticated requests for the
 * rest of the UTC day, not just until the window rolls over. See
 * docs/superpowers/specs/2026-10-12-public-geocoding-api-design.md.
 *
 * The single INSERT ... ON CONFLICT DO UPDATE atomically handles "new IP
 * today" and "existing IP, roll or extend the window" in one round trip
 * -- no separate read-then-write race between concurrent requests from
 * the same IP. An already-blocked IP still runs through this upsert
 * (cheap, one indexed row) before the blocked_at check short-circuits,
 * so window_count/window_started_at can keep moving in the background
 * for a blocked IP, but that's harmless -- blocked_at being set is
 * checked first and is what actually governs the response.
 */
async function checkRateLimit(pool, ipAddress) {
  const { rows } = await pool.query(
    `INSERT INTO geocode_rate_limits (ip_address, date, window_started_at, window_count, total_count)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, now(), 1, 1)
     ON CONFLICT (ip_address, date) DO UPDATE SET
       window_count = CASE
         WHEN geocode_rate_limits.window_started_at <= now() - interval '1 minute' THEN 1
         ELSE geocode_rate_limits.window_count + 1
       END,
       window_started_at = CASE
         WHEN geocode_rate_limits.window_started_at <= now() - interval '1 minute' THEN now()
         ELSE geocode_rate_limits.window_started_at
       END,
       total_count = geocode_rate_limits.total_count + 1
     RETURNING *`,
    [ipAddress]
  );
  const row = rows[0];

  const message =
    'Rate limit exceeded: unauthenticated requests are limited to 10/minute. ' +
    "You're blocked from further anonymous requests for the rest of today -- " +
    'buy a plan (see the Pricing page) to get a service key for uninterrupted access.';

  if (row.blocked_at) {
    throw new RateLimitError(message);
  }

  if (row.window_count > WINDOW_LIMIT) {
    // Recompute the UTC date directly in SQL rather than passing row.date
    // (a JS Date) back -- no round-trip to desync, and conditional on
    // blocked_at IS NULL so two concurrent requests racing past the
    // window_count check above can't both "win" the block-and-notify
    // below (only the one whose UPDATE actually changes a row notifies).
    const { rowCount } = await pool.query(
      `UPDATE geocode_rate_limits SET blocked_at = now()
       WHERE ip_address = $1 AND date = (now() AT TIME ZONE 'UTC')::date AND blocked_at IS NULL`,
      [ipAddress]
    );
    if (rowCount === 1) {
      await sendRateLimitBlockedNotification({ ipAddress, totalCount: row.total_count });
    }
    throw new RateLimitError(message);
  }
}

/** Same `>N days` pattern as feedback.js's deleteOldFeedback, dated off `date` (not created_at -- this table has no created_at column). */
async function deleteOldRateLimits(pool, days) {
  const { rowCount } = await pool.query(
    `DELETE FROM geocode_rate_limits WHERE date < (now() AT TIME ZONE 'UTC')::date - $1::integer`,
    [days]
  );
  return rowCount;
}

module.exports = { ensureGeocodeRateLimitsTable, checkRateLimit, deleteOldRateLimits };
