const { ValidationError } = require('./errors');

// A log of road alerts a user explicitly saved (the voice "save"/
// "keep"/"email" command, POST /road-alerts/email-alert) while an
// account is opted into the daily email digest -- never every alert the
// app happened to speak automatically, just the ones the driver
// specifically asked to keep. Rows are deleted once they've been
// included in a sent (or stubbed) digest -- see roadAlertsDigest.js --
// so this table only ever holds what's still pending, not a permanent
// history.
const CREATE_ROAD_ALERTS_SURFACED_LOG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_surfaced_log (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  roadway TEXT,
  severity TEXT NOT NULL,
  description TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  source TEXT,
  network TEXT,
  surfaced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_alerts_surfaced_log_email_idx
  ON road_alerts_surfaced_log (email);
`;

/** Creates the road_alerts_surfaced_log table if it doesn't already exist. */
async function ensureRoadAlertsSurfacedLogTable(pool) {
  await pool.query(CREATE_ROAD_ALERTS_SURFACED_LOG_TABLE_SQL);
}

/**
 * Logs one explicitly-saved alert for an account's digest. `signal` is
 * the same RoadSignal object /road-alerts/email-alert already validates
 * (see server.js) -- only signal.id is required here, everything else
 * is stored as whatever's present (roadSignals.js's normalizeIncident
 * can leave most fields null).
 */
async function insertSurfacedAlert(pool, email, signal) {
  if (!signal || typeof signal.id !== 'string') {
    throw new ValidationError('signal must be a road signal object with an id');
  }

  const { rows } = await pool.query(
    `INSERT INTO road_alerts_surfaced_log
       (email, signal_id, roadway, severity, description, latitude, longitude, source, network)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      email,
      signal.id,
      signal.roadway ?? null,
      signal.severity ?? 'need_to_know',
      signal.speech?.brief ?? signal.description ?? null,
      typeof signal.latitude === 'number' ? signal.latitude : null,
      typeof signal.longitude === 'number' ? signal.longitude : null,
      signal.source ?? null,
      signal.network ?? null,
    ]
  );
  return rows[0];
}

/**
 * Every pending (not-yet-digested) alert across every account, grouped
 * by email. Every row here belongs to an account that was opted into
 * the digest at the time it was saved (insertSurfacedAlert is only ever
 * called when digest_opt_in is true -- see server.js), so no join
 * against road_alerts_accounts is needed to filter this further.
 */
async function getPendingAlertsGroupedByEmail(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM road_alerts_surfaced_log ORDER BY email, surfaced_at'
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.email)) {
      grouped.set(row.email, []);
    }
    grouped.get(row.email).push(row);
  }
  return grouped;
}

/** Deletes specific log rows by id, once they've been included in a sent digest. */
async function deleteSurfacedAlerts(pool, ids) {
  if (!ids || ids.length === 0) return 0;
  const { rowCount } = await pool.query('DELETE FROM road_alerts_surfaced_log WHERE id = ANY($1)', [ids]);
  return rowCount;
}

module.exports = {
  ensureRoadAlertsSurfacedLogTable,
  insertSurfacedAlert,
  getPendingAlertsGroupedByEmail,
  deleteSurfacedAlerts,
};
