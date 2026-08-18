const { ValidationError } = require('./errors');

// Test-only stand-in for docs/ROAD_ALERTS_DESIGN.md's real
// `user_routine_segments` (the on-device, recency-weighted routine
// subgraph) -- that table is never meant to exist server-side at all per
// the design's privacy model ("access-controlled -- on-device by
// default"). This one deliberately does, because there's no trip-
// learning pipeline yet to produce real weighted points from, and
// exercising roadAlertsMatching.js's "hazard between the user and a
// routine point" logic against a live device (real GPS, real 511 data)
// needs *some* persisted source in the meantime. Gated behind
// ALLOW_TEST_WEIGHTED_POINTS in server.js -- never a real per-user
// privacy substitute, and never enabled where it could be mistaken for
// one.
const CREATE_TEST_WEIGHTED_POINTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_test_weighted_points (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  weight DOUBLE PRECISION NOT NULL,
  tlid TEXT,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_alerts_test_weighted_points_email_idx
  ON road_alerts_test_weighted_points (email);
`;

/** Creates the road_alerts_test_weighted_points table if it doesn't already exist. */
async function ensureTestWeightedPointsTable(pool) {
  await pool.query(CREATE_TEST_WEIGHTED_POINTS_TABLE_SQL);
}

/**
 * Adds one fake weighted point for an account. `weight` is opaque here
 * (same 0-1-ish recency-weighted scale the real design describes) --
 * this module doesn't interpret it, just stores whatever the caller
 * hands in for roadAlertsMatching.js's findAlertsForWeightedPoints to
 * threshold against later.
 */
async function addTestWeightedPoint(pool, email, { latitude, longitude, weight, tlid, label }) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError('latitude must be a number');
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError('longitude must be a number');
  }
  if (typeof weight !== 'number' || Number.isNaN(weight)) {
    throw new ValidationError('weight must be a number');
  }

  const { rows } = await pool.query(
    `INSERT INTO road_alerts_test_weighted_points (email, latitude, longitude, weight, tlid, label)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [email, latitude, longitude, weight, tlid ?? null, label ?? null]
  );
  return rows[0];
}

/** All fake weighted points stored for an account, oldest first. */
async function getTestWeightedPoints(pool, email) {
  const { rows } = await pool.query(
    'SELECT * FROM road_alerts_test_weighted_points WHERE email = $1 ORDER BY id',
    [email]
  );
  return rows;
}

/** Deletes every fake weighted point stored for an account; returns how many were removed. */
async function clearTestWeightedPoints(pool, email) {
  const { rowCount } = await pool.query('DELETE FROM road_alerts_test_weighted_points WHERE email = $1', [email]);
  return rowCount;
}

module.exports = {
  ensureTestWeightedPointsTable,
  addTestWeightedPoint,
  getTestWeightedPoints,
  clearTestWeightedPoints,
};
