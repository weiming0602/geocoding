const { flatDistanceMeters } = require('./nextCrossStreet');
const { ValidationError } = require('./errors');

// How close a new ping has to land to an existing point to be merged
// into it rather than starting a new one -- wide enough to absorb GPS
// drift on a single stretch of road, narrow enough not to blur together
// two genuinely different nearby roads.
const MATCH_RADIUS_METERS = 150;
const NEW_POINT_WEIGHT = 1;
const PING_INCREMENT = 1;
// A point's weight decays by this factor per day since it was last
// pinged, applied at read time (see getWeightedPoints) -- so a route
// someone stopped driving fades out of consideration on its own,
// without needing a background job to actively rewrite stored weights.
// This governs a point's *ongoing* relevance once it's already
// qualified (below) -- it's a separate mechanism from the qualifying
// window, not a replacement for it.
const DAILY_DECAY = 0.98;
// A brand-new point only counts as a real weighted point once it's been
// pinged this many times within a rolling window this many days wide --
// "the middle of nowhere, but iterated often" means iterated *recently
// and repeatedly*, not just twice, ever. A point that hasn't cleared
// this bar yet is never returned by getWeightedPoints, so it can't
// trigger an alert or be mistaken for a routine route -- matching the
// original design's "only segments whose weight crosses a threshold are
// persisted at all" intent, just enforced at serving time rather than
// by withholding the row.
const QUALIFYING_WINDOW_DAYS = 7;
const MIN_PINGS_TO_QUALIFY = 3;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_weighted_points (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  weight DOUBLE PRECISION NOT NULL DEFAULT 0,
  tlid TEXT,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_ping_count INTEGER NOT NULL DEFAULT 1,
  qualified_at TIMESTAMPTZ,
  last_pinged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_alerts_weighted_points_email_idx
  ON road_alerts_weighted_points (email);
`;

/** Creates the road_alerts_weighted_points table if it doesn't already exist. */
async function ensureWeightedPointsTable(pool) {
  await pool.query(CREATE_TABLE_SQL);
}

/**
 * Records one GPS ping from an active Road Alerts monitoring session
 * toward a user's routine-route model -- the real, production version
 * of what testWeightedPoints.js's ALLOW_TEST_WEIGHTED_POINTS-gated
 * table stood in for before a real source of pings existed.
 *
 * Deliberately excludes trip endpoints (`isEndpoint: true`): the point
 * of a "weighted point" is a spot driven *through* repeatedly -- a
 * stretch of highway, a regular turn, some stretch of road that's
 * nowhere in particular but gets iterated often -- not a destination
 * (home, work, a specific store). Recording actual start/end points
 * would capture meaningfully identifying locations this feature never
 * needed in the first place, so an endpoint ping is a deliberate no-op,
 * not a filtered-out edge case. The caller (the mobile app, watching
 * its own monitoring session) is what knows which pings are endpoints;
 * this function just enforces the exclusion once told.
 *
 * Every point (qualified or not) still gets a row and still accrues
 * weight/pings from the first ping onward -- qualification (see
 * QUALIFYING_WINDOW_DAYS/MIN_PINGS_TO_QUALIFY above) only gates whether
 * getWeightedPoints will ever *return* it, not whether it's tracked.
 */
async function recordWeightedPointPing(pool, email, { latitude, longitude, tlid, isEndpoint }) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError('latitude must be a number');
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError('longitude must be a number');
  }
  if (isEndpoint) {
    return null;
  }

  const { rows: existing } = await pool.query(
    `SELECT id, latitude, longitude, weight, window_started_at, window_ping_count, qualified_at, last_pinged_at
     FROM road_alerts_weighted_points WHERE email = $1`,
    [email]
  );

  let nearest = null;
  let nearestDistance = Infinity;
  for (const row of existing) {
    const distance = flatDistanceMeters(latitude, longitude, row.latitude, row.longitude);
    if (distance < nearestDistance) {
      nearest = row;
      nearestDistance = distance;
    }
  }

  if (nearest && nearestDistance <= MATCH_RADIUS_METERS) {
    const now = new Date();
    const windowAgeDays = (now.getTime() - new Date(nearest.window_started_at).getTime()) / 86400000;
    // A window older than QUALIFYING_WINDOW_DAYS has expired -- this
    // ping starts a fresh one rather than extending a stale count, so
    // "3 times this week" can't be satisfied by e.g. one ping each in
    // three unrelated months.
    const windowExpired = windowAgeDays > QUALIFYING_WINDOW_DAYS;
    const windowStartedAt = windowExpired ? now : nearest.window_started_at;
    const windowPingCount = windowExpired ? 1 : nearest.window_ping_count + 1;
    const nowQualifies = windowPingCount >= MIN_PINGS_TO_QUALIFY;

    const daysSinceLastPing = (now.getTime() - new Date(nearest.last_pinged_at).getTime()) / 86400000;
    const decayedWeight = nearest.weight * DAILY_DECAY ** Math.max(daysSinceLastPing, 0);

    const { rows } = await pool.query(
      `UPDATE road_alerts_weighted_points
       SET weight = $1, last_pinged_at = now(), tlid = COALESCE($2, tlid),
           window_started_at = $3, window_ping_count = $4,
           qualified_at = COALESCE(qualified_at, CASE WHEN $5 THEN now() ELSE NULL END)
       WHERE id = $6 RETURNING *`,
      [decayedWeight + PING_INCREMENT, tlid ?? null, windowStartedAt, windowPingCount, nowQualifies, nearest.id]
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO road_alerts_weighted_points (email, latitude, longitude, weight, tlid)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [email, latitude, longitude, NEW_POINT_WEIGHT, tlid ?? null]
  );
  return rows[0];
}

/**
 * Returns an account's *qualified* weighted points only (see
 * MIN_PINGS_TO_QUALIFY) -- a point that hasn't earned qualified_at yet
 * is tracked internally but never surfaced here, so it can't affect
 * alerting. Each returned point's weight is decayed to its current (not
 * last-write-time) value, so a point that hasn't been pinged in a while
 * reports a lower weight even without a new ping to trigger
 * recalculation, and roadAlertsMatching.js's minWeight threshold
 * naturally excludes it once it's decayed low enough.
 */
async function getWeightedPoints(pool, email) {
  const { rows } = await pool.query(
    `SELECT latitude, longitude, weight, tlid, last_pinged_at
     FROM road_alerts_weighted_points WHERE email = $1 AND qualified_at IS NOT NULL`,
    [email]
  );

  return rows
    .map((row) => {
      const daysSincePing = (Date.now() - new Date(row.last_pinged_at).getTime()) / 86400000;
      return {
        latitude: row.latitude,
        longitude: row.longitude,
        tlid: row.tlid,
        weight: row.weight * DAILY_DECAY ** Math.max(daysSincePing, 0),
      };
    })
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Deletes points not pinged in over `days` -- decay alone (see
 * getWeightedPoints) only lowers a stale point's *reported* weight, it
 * never removes the row, so without this a table like this one only
 * grows: every point that never qualified (or qualified once and was
 * then abandoned) sits there forever. Meant to run periodically -- see
 * ops/geocoding-weighted-points-cleanup.timer (or ops/crontab.example
 * for a plain-cron alternative), same pattern as feedback.js's
 * deleteOldFeedback.
 */
async function deleteStalePoints(pool, days) {
  const { rowCount } = await pool.query(
    "DELETE FROM road_alerts_weighted_points WHERE last_pinged_at < now() - ($1 * interval '1 day')",
    [days]
  );
  return rowCount;
}

module.exports = {
  ensureWeightedPointsTable,
  recordWeightedPointPing,
  getWeightedPoints,
  deleteStalePoints,
  MATCH_RADIUS_METERS,
  QUALIFYING_WINDOW_DAYS,
  MIN_PINGS_TO_QUALIFY,
};
