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

/**
 * Claims one LLM call under `email`'s `dailyCap` for `context`, before the
 * call is made: counts today's rows and inserts this attempt's row in one
 * transaction, serialized per account+context by an advisory lock. Counting
 * first and only logging once the LLM had answered let every concurrent
 * request (and a batch's parallel retry workers) read the same count and
 * all go over the cap together -- and an attempt that threw after the LLM
 * answered was never logged, so never counted at all.
 *
 * Returns the new row's id (fill it in with finishLlmGeocodeAssist), or
 * null when the cap is already reached (nothing inserted).
 */
async function claimLlmGeocodeAssist(pool, { email, originalInput, candidates, context = 'single', dailyCap }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm_geocode_assists:${context}:${email}`]);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM llm_geocode_assists
       WHERE email = $1 AND context = $2 AND created_at > now() - interval '1 day'`,
      [email, context]
    );
    if (rows[0].n >= dailyCap) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows: inserted } = await client.query(
      `INSERT INTO llm_geocode_assists (email, original_input, candidates_considered, picked, succeeded, failure_reason, context)
       VALUES ($1, $2, $3, NULL, false, 'in_progress', $4)
       RETURNING id`,
      [email, originalInput, JSON.stringify(candidates), context]
    );
    await client.query('COMMIT');
    return inserted[0].id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Records the outcome of an attempt claimed by claimLlmGeocodeAssist. */
async function finishLlmGeocodeAssist(pool, id, { picked, succeeded, failureReason }) {
  await pool.query(
    'UPDATE llm_geocode_assists SET picked = $2, succeeded = $3, failure_reason = $4 WHERE id = $1',
    [id, picked, succeeded, failureReason]
  );
}

module.exports = {
  ensureLlmGeocodeAssistsTable,
  logLlmGeocodeAssist,
  claimLlmGeocodeAssist,
  finishLlmGeocodeAssist,
};
