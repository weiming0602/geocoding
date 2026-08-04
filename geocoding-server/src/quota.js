const { getUser, ensureCurrentPeriod, recordUsage } = require('./users');
const { NotFoundError, QuotaExceededError } = require('./errors');

/**
 * Looks up a user by email, rolls their usage over if a new billing
 * month has started, and verifies they have enough remaining quota for
 * `requestedCount` more addresses this period. Throws NotFoundError for
 * an unknown email, QuotaExceededError if the request would exceed the
 * plan. Returns the (possibly period-refreshed) user row on success.
 */
async function checkQuota(usersDb, email, requestedCount) {
  const user = await getUser(usersDb, email);
  if (!user) {
    throw new NotFoundError(`no active subscription found for ${email}`);
  }

  const current = await ensureCurrentPeriod(usersDb, user);
  const remaining = current.tier - current.used_this_period;

  if (requestedCount > remaining) {
    throw new QuotaExceededError(
      `this batch has ${requestedCount} addresses, but only ${remaining} remain this period ` +
        `(${current.used_this_period}/${current.tier} used)`
    );
  }

  return current;
}

async function useQuota(usersDb, email, count) {
  await recordUsage(usersDb, email, count);
}

module.exports = { checkQuota, useQuota };
