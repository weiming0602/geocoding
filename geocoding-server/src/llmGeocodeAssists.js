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

// Which path made the attempt -- 'single' (POST /geocode) or 'batch' (the
// three batch endpoints) -- so each has its own daily cap (see
// llmAssist.js). Rows from before this column existed were all single
// geocodes, hence the default.
const ADD_CONTEXT_COLUMN_SQL = `
ALTER TABLE llm_geocode_assists ADD COLUMN IF NOT EXISTS context TEXT NOT NULL DEFAULT 'single';
`;

async function ensureLlmGeocodeAssistsTable(pool) {
  await pool.query(CREATE_TABLE_SQL);
  await pool.query(ADD_CONTEXT_COLUMN_SQL);
}

/**
 * Logs one LLM-assisted geocode attempt -- called by llmAssist.js for
 * every attempt that reaches the LLM step (passed the coverage check,
 * was authenticated, and had at least one real candidate). Reviewed
 * manually via psql, same convention as feedback.js's table -- no
 * listing/review endpoint, no digest.
 */
async function logLlmGeocodeAssist(
  pool,
  { email, originalInput, candidates, picked, succeeded, failureReason, context = 'single' }
) {
  await pool.query(
    `INSERT INTO llm_geocode_assists (email, original_input, candidates_considered, picked, succeeded, failure_reason, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [email, originalInput, JSON.stringify(candidates), picked, succeeded, failureReason, context]
  );
}

module.exports = { ensureLlmGeocodeAssistsTable, logLlmGeocodeAssist };
