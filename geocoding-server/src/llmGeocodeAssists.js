const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS llm_geocode_assists (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  original_input TEXT NOT NULL,
  candidates_considered JSONB NOT NULL,
  picked TEXT,
  succeeded BOOLEAN NOT NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function ensureLlmGeocodeAssistsTable(pool) {
  await pool.query(CREATE_TABLE_SQL);
}

/**
 * Logs one LLM-assisted geocode attempt -- called by llmAssist.js for
 * every attempt that reaches the LLM step (passed the coverage check,
 * was authenticated, and had at least one real candidate). Reviewed
 * manually via psql, same convention as feedback.js's table -- no
 * listing/review endpoint, no digest.
 */
async function logLlmGeocodeAssist(pool, { email, originalInput, candidates, picked, succeeded, failureReason }) {
  await pool.query(
    `INSERT INTO llm_geocode_assists (email, original_input, candidates_considered, picked, succeeded, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [email, originalInput, JSON.stringify(candidates), picked, succeeded, failureReason]
  );
}

module.exports = { ensureLlmGeocodeAssistsTable, logLlmGeocodeAssist };
