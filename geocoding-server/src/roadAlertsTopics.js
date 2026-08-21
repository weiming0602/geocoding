// A topic anchored to a persistent road location -- deliberately NOT
// to a specific 511 signal.id, which can disappear from the live feed
// once a hazard clears (see roadAlertsTopicAnchor.js for how a point
// resolves to the tlid a topic is keyed by). This is what lets a
// conversation about a chronic problem spot survive the alert that
// started it.
const CREATE_ROAD_ALERTS_TOPICS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_topics (
  id BIGSERIAL PRIMARY KEY,
  tlid TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  roadway TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partial (tlid IS NOT NULL only, since NULL never conflicts with NULL
-- in a unique index -- the rounded-coordinate fallback path below is
-- unprotected by this and accepts a rare duplicate-topic race, since it
-- only runs when tlid resolution already failed) -- lets the primary
-- path use ON CONFLICT DO NOTHING, the same race-safe pattern
-- roadAlertsAccounts.js's registerAccount already establishes, so two
-- concurrent first-time posts at the same new segment can't create two
-- topics.
CREATE UNIQUE INDEX IF NOT EXISTS road_alerts_topics_tlid_idx
  ON road_alerts_topics (tlid) WHERE tlid IS NOT NULL;
`;

/** Creates the road_alerts_topics table if it doesn't already exist. */
async function ensureRoadAlertsTopicsTable(pool) {
  await pool.query(CREATE_ROAD_ALERTS_TOPICS_TABLE_SQL);
}

/**
 * Finds an existing topic for a location without creating one -- used
 * by the read-only GET route, so merely viewing an alert never creates
 * a topic nobody's actually commented on. Same tlid-first, rounded-
 * coordinate-fallback lookup as findOrCreateTopic, just without the
 * INSERT branch.
 */
async function findTopic(pool, { tlid, latitude, longitude }) {
  if (tlid) {
    const { rows } = await pool.query('SELECT * FROM road_alerts_topics WHERE tlid = $1', [tlid]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT * FROM road_alerts_topics
     WHERE tlid IS NULL AND round(latitude::numeric, 5) = round($1::numeric, 5)
       AND round(longitude::numeric, 5) = round($2::numeric, 5)`,
    [latitude, longitude]
  );
  return rows[0];
}

/**
 * Finds or creates a topic for a location -- the only path that ever
 * creates one. `tlid` present: keyed by street segment, the primary
 * mechanism ("anchored to a persistent road location"). `tlid` null
 * (the point falls outside this app's street-data coverage -- rare,
 * but the `streets` table isn't exhaustive): falls back to a rounded-
 * coordinate match (~1m precision) so repeated posts at the same spot
 * still land on one topic instead of a new row each time.
 */
async function findOrCreateTopic(pool, { tlid, latitude, longitude, roadway }) {
  const existing = await findTopic(pool, { tlid, latitude, longitude });
  if (existing) return existing;

  if (tlid) {
    // ON CONFLICT DO NOTHING + a fallback SELECT, same race-safe shape
    // as registerAccount: if a concurrent request's INSERT wins first,
    // this one's RETURNING comes back empty and the follow-up SELECT
    // picks up the winner's row instead of erroring or duplicating.
    const inserted = await pool.query(
      `INSERT INTO road_alerts_topics (tlid, latitude, longitude, roadway)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tlid) WHERE tlid IS NOT NULL DO NOTHING
       RETURNING *`,
      [tlid, latitude, longitude, roadway ?? null]
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const { rows } = await pool.query('SELECT * FROM road_alerts_topics WHERE tlid = $1', [tlid]);
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO road_alerts_topics (tlid, latitude, longitude, roadway)
     VALUES (NULL, $1, $2, $3)
     RETURNING *`,
    [latitude, longitude, roadway ?? null]
  );
  return rows[0];
}

module.exports = {
  ensureRoadAlertsTopicsTable,
  findTopic,
  findOrCreateTopic,
};
