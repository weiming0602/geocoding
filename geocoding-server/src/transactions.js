const CREATE_TRANSACTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  order_id TEXT NOT NULL,
  address_count INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_created_at_idx ON transactions (created_at DESC);
`;

/** Creates the transactions table if it doesn't already exist. */
async function ensureTransactionsTable(pool) {
  await pool.query(CREATE_TRANSACTIONS_TABLE_SQL);
}

/**
 * Records one completed purchase -- called from POST /billing/purchase
 * only after captureOrder() has actually confirmed the money moved and
 * addToTier() has granted the quota, so every row here represents a real,
 * successful transaction, never an attempt that failed validation or
 * PayPal capture. `tier` is the account's resulting total tier (not just
 * this purchase's addressCount), matching what the purchase response
 * already reports back to the client.
 */
async function recordTransaction(pool, { email, orderId, addressCount, priceCents, tier }) {
  const { rows } = await pool.query(
    `INSERT INTO transactions (email, order_id, address_count, price_cents, tier)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [email, orderId, addressCount, priceCents, tier]
  );
  return rows[0];
}

/** Lists the most recent transactions, newest first, for the admin transactions page. */
async function listTransactions(pool, { limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Transactions not yet included in a daily owner-notification email --
 * `notified_at` is set once a digest send succeeds (see
 * markTransactionsNotified), so a run that finds nothing pending sends no
 * email at all, and a failed send leaves rows in place for the next run
 * to retry, same pattern as roadAlertsSurfacedLog.js's pending queue.
 * Unlike that table's rows, these are never deleted -- a transaction is a
 * financial record, kept indefinitely.
 */
async function getUnnotifiedTransactions(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM transactions WHERE notified_at IS NULL ORDER BY created_at ASC`
  );
  return rows;
}

/** Marks the given transaction ids as included in a successfully-sent digest. */
async function markTransactionsNotified(pool, ids) {
  if (!ids.length) return;
  await pool.query(`UPDATE transactions SET notified_at = now() WHERE id = ANY($1)`, [ids]);
}

module.exports = {
  ensureTransactionsTable,
  recordTransaction,
  listTransactions,
  getUnnotifiedTransactions,
  markTransactionsNotified,
};
