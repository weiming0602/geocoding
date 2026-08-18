const { sendRoadAlertsDigestEmail } = require('./emailDelivery');
const { getPendingAlertsGroupedByEmail, deleteSurfacedAlerts } = require('./roadAlertsSurfacedLog');

/**
 * Sends every opted-in account's pending digest and clears what was
 * sent. An account with nothing pending is skipped entirely -- no
 * "nothing happened today" email. A real SES failure (result.error set)
 * leaves that account's rows in place so the next run retries them; a
 * successful send or a no-SES dev/test stub both count as "done" and
 * clear the rows, since re-sending them tomorrow would be a duplicate,
 * not a retry. See scripts/road-alerts-digest.js for the script meant
 * to run this daily.
 */
async function runDailyDigest(pool) {
  const grouped = await getPendingAlertsGroupedByEmail(pool);
  let accountsDigested = 0;
  let emailsSent = 0;

  for (const [email, rows] of grouped) {
    const result = await sendRoadAlertsDigestEmail(email, rows);
    accountsDigested += 1;
    if (result.delivered || result.stubbed) {
      await deleteSurfacedAlerts(pool, rows.map((row) => row.id));
      emailsSent += 1;
    }
  }

  return { accountsDigested, emailsSent };
}

module.exports = { runDailyDigest };
