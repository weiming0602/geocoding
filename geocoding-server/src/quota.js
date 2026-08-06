const { getUser, verifyServiceKey, ensureCurrentPeriod, recordUsage } = require('./users');
const { NotFoundError, QuotaExceededError, UnauthorizedError } = require('./errors');

// Lets a local/test box skip entering a service key at all -- an empty
// key is accepted for ANY known email, so it must never be set
// anywhere real customers' quota is actually at stake (it defeats the
// entire point of the service key: knowing just an email becomes
// enough to spend that account's quota again). Off unless explicitly
// enabled; server.js logs a loud startup warning when it's on.
function allowsEmptyServiceKeyForTesting() {
  return process.env.ALLOW_TEST_EMPTY_SERVICE_KEY === 'true';
}

/**
 * Looks up a user by email, verifies their service key matches (so
 * knowing an account's email alone isn't enough to spend its quota --
 * see users.js's generateServiceKey), rolls their usage over if a new
 * billing month has started, and verifies they have enough remaining
 * quota for `requestedCount` more addresses this period. Throws
 * NotFoundError for an unknown email, UnauthorizedError for a wrong/
 * missing key, QuotaExceededError if the request would exceed the plan.
 * Returns the (possibly period-refreshed) user row on success.
 */
async function checkQuota(usersDb, email, serviceKey, requestedCount) {
  const user = await getUser(usersDb, email);
  if (!user) {
    throw new NotFoundError(`no active subscription found for ${email}`);
  }
  const skipKeyCheck = !serviceKey && allowsEmptyServiceKeyForTesting();
  if (!skipKeyCheck && !(await verifyServiceKey(usersDb, email, serviceKey))) {
    throw new UnauthorizedError('service key is missing or does not match this account');
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
