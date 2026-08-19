const { ValidationError } = require('./errors');

// A statement is either a top-level post on a topic (parent_statement_id
// NULL) or a reply to one (parent_statement_id set) -- capped at
// exactly one level, enforced in insertStatement below, never a reply
// to a reply. `username` is denormalized onto each row at post time
// (same pattern road_alerts_surfaced_log.js uses for signal fields),
// preserving what name the author had when they posted rather than
// joining against road_alerts_accounts, which could change later.
const CREATE_ROAD_ALERTS_STATEMENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_statements (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL,
  parent_statement_id BIGINT,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_alerts_statements_topic_id_idx ON road_alerts_statements (topic_id);
CREATE INDEX IF NOT EXISTS road_alerts_statements_parent_statement_id_idx ON road_alerts_statements (parent_statement_id);
`;

/** Creates the road_alerts_statements table if it doesn't already exist. */
async function ensureRoadAlertsStatementsTable(pool) {
  await pool.query(CREATE_ROAD_ALERTS_STATEMENTS_TABLE_SQL);
}

/** Looks up one statement by id, or undefined if it doesn't exist. */
async function getStatement(pool, id) {
  const { rows } = await pool.query('SELECT * FROM road_alerts_statements WHERE id = $1', [id]);
  return rows[0];
}

/**
 * Inserts a statement. The one-level-cap enforcement lives here, not
 * in the route handler, so any future caller gets the same guarantee:
 * if `parentStatementId` is given, that parent must itself be a
 * top-level statement (parent_statement_id IS NULL) -- a reply to a
 * reply throws ValidationError instead of silently nesting further.
 */
async function insertStatement(pool, { topicId, parentStatementId, email, username, body }) {
  if (parentStatementId != null) {
    const parent = await getStatement(pool, parentStatementId);
    if (!parent) {
      throw new ValidationError(`no statement found with id ${parentStatementId}`);
    }
    if (parent.parent_statement_id !== null) {
      throw new ValidationError('cannot reply to a reply -- statements are capped at one level');
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO road_alerts_statements (topic_id, parent_statement_id, email, username, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [topicId, parentStatementId ?? null, email, username, body]
  );
  return rows[0];
}

/**
 * Every statement for a topic, top-level statements each carrying
 * their own flat `replies` array -- never itself nested, since
 * insertStatement never lets a reply's parent be anything but
 * top-level. Ordered oldest-first within each level.
 */
async function getStatementsForTopic(pool, topicId) {
  const { rows } = await pool.query(
    'SELECT * FROM road_alerts_statements WHERE topic_id = $1 ORDER BY created_at',
    [topicId]
  );

  const topLevel = rows.filter((row) => row.parent_statement_id === null);
  const repliesByParentId = new Map();
  for (const row of rows) {
    if (row.parent_statement_id === null) continue;
    if (!repliesByParentId.has(row.parent_statement_id)) {
      repliesByParentId.set(row.parent_statement_id, []);
    }
    repliesByParentId.get(row.parent_statement_id).push(row);
  }

  return topLevel.map((statement) => ({
    ...statement,
    replies: repliesByParentId.get(statement.id) ?? [],
  }));
}

module.exports = {
  ensureRoadAlertsStatementsTable,
  getStatement,
  insertStatement,
  getStatementsForTopic,
};
