const { addToTier } = require('./users');

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
-- One row per payment (a PayPal order id on older rows, a Stripe Checkout
-- Session id since) -- what makes fulfillPurchase() safe to call from both
-- the Stripe webhook and the returning browser for the same payment.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_order_id_key ON transactions (order_id);
`;

/** Creates the transactions table if it doesn't already exist. */
async function ensureTransactionsTable(pool) {
  await pool.query(CREATE_TRANSACTIONS_TABLE_SQL);
}

/**
 * Records one completed purchase -- only ever called once a payment has
 * actually been confirmed (see fulfillPurchase), so every row here
 * represents a real, successful transaction, never an attempt that failed
 * validation or payment. `tier` is the account's resulting total tier (not
 * just this purchase's addressCount), matching what the purchase response
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

/**
 * Grants a paid purchase's quota and records its transaction row in one
 * database transaction, at most once per `orderId`. Stripe's webhook and
 * the browser returning from Stripe's checkout page both fulfill the same
 * payment, often within milliseconds of each other -- whichever commits
 * first wins; the other blocks on the unique order_id index, inserts
 * nothing, and rolls its quota grant back. Returns `{ user, transaction }`
 * -- `transaction` is null when this payment had already been fulfilled.
 */
async function fulfillPurchase(pool, { email, orderId, addressCount, priceCents }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await addToTier(client, email, addressCount);
    const { rows } = await client.query(
      `INSERT INTO transactions (email, order_id, address_count, price_cents, tier)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id) DO NOTHING RETURNING *`,
      [user.email, orderId, addressCount, priceCents, user.tier]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      const { rows: current } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      return { user: current[0], transaction: null };
    }
    await client.query('COMMIT');
    return { user, transaction: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  fulfillPurchase,
  listTransactions,
  getUnnotifiedTransactions,
  markTransactionsNotified,
};
