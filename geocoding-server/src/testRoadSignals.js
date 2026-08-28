const { ValidationError } = require('./errors');
const { buildSpeech, categorizeHazard } = require('./roadSignals');

// Test-only stand-in for a real New England 511 incident -- same
// reasoning as testWeightedPoints.js's fake weighted points: these exist
// purely because a real hazard can clear from the live feed (or a driver
// can just move out of range) at any moment, which makes it hard to sit
// down and actually exercise the map/comments/reroute UI over more than
// a few minutes at a time. A row here is persisted in Postgres until
// explicitly deleted -- unlike a real 511 incident, it does NOT expire on
// its own after a few days. Gated behind ALLOW_TEST_ROAD_SIGNALS in
// server.js -- never a real hazard, and never enabled anywhere a real
// driver could mistake one for an actual live hazard.
const VALID_SEVERITIES = ['serious', 'need_to_know', 'proximity', 'fun_to_know'];

const CREATE_TEST_ROAD_SIGNALS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_test_signals (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  roadway TEXT,
  description TEXT,
  severity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_alerts_test_signals_email_idx
  ON road_alerts_test_signals (email);
`;

/** Creates the road_alerts_test_signals table if it doesn't already exist. */
async function ensureTestRoadSignalsTable(pool) {
  await pool.query(CREATE_TEST_ROAD_SIGNALS_TABLE_SQL);
}

/** Adds one fake hazard for an account. */
async function addTestRoadSignal(pool, email, { latitude, longitude, roadway, description, severity }) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError('latitude must be a number');
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError('longitude must be a number');
  }
  const resolvedSeverity = severity ?? 'need_to_know';
  if (!VALID_SEVERITIES.includes(resolvedSeverity)) {
    throw new ValidationError(`severity must be one of: ${VALID_SEVERITIES.join(', ')}`);
  }

  const { rows } = await pool.query(
    `INSERT INTO road_alerts_test_signals (email, latitude, longitude, roadway, description, severity)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [email, latitude, longitude, roadway ?? null, description ?? null, resolvedSeverity]
  );
  return rows[0];
}

/** All fake hazards stored for an account, oldest first. */
async function getTestRoadSignalRows(pool, email) {
  const { rows } = await pool.query('SELECT * FROM road_alerts_test_signals WHERE email = $1 ORDER BY id', [email]);
  return rows;
}

/** Deletes every fake hazard stored for an account; returns how many were removed. */
async function clearTestRoadSignals(pool, email) {
  const { rowCount } = await pool.query('DELETE FROM road_alerts_test_signals WHERE email = $1', [email]);
  return rowCount;
}

/**
 * Shapes a stored row into the same RoadSignal object normalizeIncident
 * (roadSignals.js) produces for a real incident, so every downstream
 * consumer -- filterByBbox, sortByFreshness, findAlertsForWeightedPoints,
 * the speech synthesis, the reroute endpoint's hazard lookup, both apps'
 * rendering -- treats it identically to a live one, with no special-
 * casing anywhere else in the codebase. `id` is prefixed `test-` so it
 * can never collide with a real 511 incident id.
 */
function toRoadSignal(row) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  const normalized = {
    id: `test-${row.id}`,
    type: 'traffic_hazard',
    source: 'Test (developer-seeded)',
    network: 'Test',
    status: 'Test',
    roadway: row.roadway,
    direction: null,
    crossStreet: null,
    mileMarker: null,
    county: null,
    city: null,
    latitude: row.latitude,
    longitude: row.longitude,
    affectedLanes: null,
    affectedLanesDetail: null,
    weightRestriction: null,
    description: row.description,
    verifiedBy: null,
    createdAt,
    lastUpdatedAt: createdAt,
    raw511Severity: null,
    raw511EventType: null,
    severity: row.severity,
  };
  // Category is derived from the description text same as a real
  // incident (categorizeHazard reads eventType/description, and a test
  // row has no eventType), not developer-specified -- lets a seeded
  // "Water Main Break" or "chemical spill" row exercise the same icon
  // logic a real one would, without adding a second way to set it.
  normalized.hazardCategory = categorizeHazard(normalized);
  normalized.speech = buildSpeech(normalized);
  return normalized;
}

/** All fake hazards stored for an account, already shaped as RoadSignals. */
async function getTestRoadSignals(pool, email) {
  const rows = await getTestRoadSignalRows(pool, email);
  return rows.map(toRoadSignal);
}

module.exports = {
  ensureTestRoadSignalsTable,
  addTestRoadSignal,
  getTestRoadSignals,
  clearTestRoadSignals,
  toRoadSignal,
  VALID_SEVERITIES,
};
