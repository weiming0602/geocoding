const CREATE_FEEDBACK_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  name TEXT,
  email TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** Creates the feedback table if it doesn't already exist. */
async function ensureFeedbackTable(pool) {
  await pool.query(CREATE_FEEDBACK_TABLE_SQL);
}

/**
 * Records a comment/question. `name` is just whatever the commenter
 * typed -- a first name, a nickname, "anonymous", anything -- not a
 * verified identity, so it's stored as-is with no validation beyond
 * being a string. There's no public listing endpoint for this table
 * (that would mean serving up whatever email addresses people left
 * along with their comment) -- reviewing feedback is a manual admin
 * operation, same as users.js's upsertUser, e.g. a direct
 * `SELECT * FROM feedback ORDER BY created_at DESC` via psql.
 */
async function submitFeedback(pool, { name, email, message }) {
  const { rows } = await pool.query(
    'INSERT INTO feedback (name, email, message) VALUES ($1, $2, $3) RETURNING *',
    [name || null, email || null, message]
  );
  return rows[0];
}

/**
 * Deletes feedback older than `days` days, so the table (and any email
 * addresses left with old comments) doesn't accumulate forever. Returns
 * the number of rows deleted. See scripts/cleanup-feedback.js for the
 * script meant to run this periodically.
 */
async function deleteOldFeedback(pool, days) {
  const { rowCount } = await pool.query(
    "DELETE FROM feedback WHERE created_at < now() - ($1 * interval '1 day')",
    [days]
  );
  return rowCount;
}

module.exports = { ensureFeedbackTable, submitFeedback, deleteOldFeedback };
