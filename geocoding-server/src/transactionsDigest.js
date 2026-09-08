const { sendTransactionsDigestEmail } = require('./emailDelivery');
const { getUnnotifiedTransactions, markTransactionsNotified } = require('./transactions');

/**
 * Emails the owner every transaction completed since the last digest and
 * marks them notified. Nothing pending means no email at all -- no
 * "no transactions today" noise. A real send failure (result.error set)
 * leaves those rows unmarked so the next run retries them; a successful
 * send or a no-Resend dev/test stub both count as "done". See
 * scripts/transactions-digest.js for the script meant to run this daily.
 */
async function runDailyTransactionsDigest(pool) {
  const pending = await getUnnotifiedTransactions(pool);
  if (!pending.length) {
    return { transactionsNotified: 0, emailSent: false };
  }

  const result = await sendTransactionsDigestEmail(pending);
  if (result.delivered || result.stubbed) {
    await markTransactionsNotified(pool, pending.map((t) => t.id));
    return { transactionsNotified: pending.length, emailSent: true };
  }
  return { transactionsNotified: 0, emailSent: false };
}

module.exports = { runDailyTransactionsDigest };
