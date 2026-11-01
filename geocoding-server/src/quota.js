const { getUser, verifyServiceKey, ensureCurrentPeriod, reserveUsage, releaseUsage } = require('./users');
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
 * see users.js's generateServiceKey), and atomically reserves
 * `requestedCount` addresses of this period's quota (rolling usage over
 * first if a new billing month has started). Throws NotFoundError for an
 * unknown email, UnauthorizedError for a wrong/missing key,
 * QuotaExceededError if the request would exceed the plan.
 *
 * The reservation is charged up front, not after the work is done:
 * checking remaining quota first and recording usage only once a batch
 * finished let every request that overlapped a slow batch see the same
 * remaining quota -- 8 concurrent 10-address batches all succeeded on a
 * 10-address plan. A caller that turns out not to owe the charge (a
 * single geocode that wasn't found, a batch that crashed) gives it back
 * with releaseQuota.
 *
 * Returns the user row with the reservation already counted in
 * used_this_period.
 */
async function reserveQuota(usersDb, email, serviceKey, requestedCount) {
  const user = await getUser(usersDb, email);
  if (!user) {
    throw new NotFoundError(`no active subscription found for ${email}`);
  }
  const skipKeyCheck = !serviceKey && allowsEmptyServiceKeyForTesting();
  if (!skipKeyCheck && !(await verifyServiceKey(usersDb, email, serviceKey))) {
    throw new UnauthorizedError('service key is missing or does not match this account');
  }

  const reserved = await reserveUsage(usersDb, email, requestedCount);
  if (!reserved) {
    const current = await ensureCurrentPeriod(usersDb, await getUser(usersDb, email));
    const remaining = current.tier - current.used_this_period;
    throw new QuotaExceededError(
      `this batch has ${requestedCount} addresses, but only ${remaining} remain this period ` +
        `(${current.used_this_period}/${current.tier} used)`
    );
  }
  return reserved;
}

/** Gives back `count` addresses that reserveQuota charged to `reservedUser` (the row it returned). */
async function releaseQuota(usersDb, reservedUser, count) {
  await releaseUsage(usersDb, reservedUser.email, count, reservedUser.period_start);
}

module.exports = { reserveQuota, releaseQuota };
