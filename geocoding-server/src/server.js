require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createReadOnlyPool } = require('./db');

const { geocode } = require('./geocode');
const {
  geocodeAddressList,
  readAddressLines,
  readAddressContent,
} = require('./batchGeocode');
const { resultsToCsv } = require('./resultsCsv');
const { buildZip } = require('./zip');
const { reverseGeocode } = require('./reverseGeocode');
const { searchPlaces } = require('./placesSearch');
const { getRoadSignals, filterByBbox, sortByFreshness } = require('./roadSignals');
const { findNextCrossStreet } = require('./nextCrossStreet');
const { getRoadReroute } = require('./roadReroute');
const {
  ensureRoadAlertsAccountsTable,
  registerAccount,
  checkAccess: checkRoadAlertsAccess,
  updateDigestOptIn,
  updateUsername,
  markNotificationsViewed,
} = require('./roadAlertsAccounts');
const {
  ensureRoadAlertsSurfacedLogTable,
  insertSurfacedAlert,
} = require('./roadAlertsSurfacedLog');
const { ensureRoadAlertsTopicsTable, findTopic, findOrCreateTopic } = require('./roadAlertsTopics');
const { resolveTlid } = require('./roadAlertsTopicAnchor');
const {
  ensureRoadAlertsStatementsTable,
  getStatement,
  insertStatement,
  getStatementsForTopic,
  getUnseenReplyCount,
} = require('./roadAlertsStatements');
const {
  ensureTestWeightedPointsTable,
  addTestWeightedPoint,
  getTestWeightedPoints,
  clearTestWeightedPoints,
} = require('./testWeightedPoints');
const {
  ensureWeightedPointsTable,
  recordWeightedPointPing,
  getWeightedPoints,
} = require('./weightedPoints');
const {
  ensureTestRoadSignalsTable,
  addTestRoadSignal,
  getTestRoadSignals,
  clearTestRoadSignals,
} = require('./testRoadSignals');
const { openUsersDb, getUser, ensureCurrentPeriod, addToTier } = require('./users');
const { ensureFeedbackTable, submitFeedback } = require('./feedback');
const { checkQuota, useQuota } = require('./quota');
const {
  sendResultsEmail,
  sendServiceKeyEmail,
  sendRoadAlertsWelcomeEmail,
  sendRoadAlertEmail,
  sendFeedbackNotification,
} = require('./emailDelivery');
const { findTier } = require('./pricing');
const { captureOrder } = require('./billing');
const {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
  PaymentError,
  UnauthorizedError,
  UpstreamError,
} = require('./errors');

// Unix socket, peer-authenticated (no password) -- the socket path must be
// percent-encoded into the URI's host component (%2Fvar%2Frun%2Fpostgresql),
// since node-postgres only honors a Unix socket path passed this way or as
// a plain `host` config field, not as a bare connection-string host.
const GEOCODING_DSN =
  process.env.GEOCODING_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding';
const USERS_DSN =
  process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';
const PORT = Number(process.env.PORT) || 3001;
const OFFSET_FEET = Number(process.env.OFFSET_FEET) || 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Lets /geocode/batch and /geocode/batch/download run with no email and
// no serviceKey at all -- a pure smoke test with no account/quota
// involved (see the emailProvided checks in each route below), and lets
// an email that IS given skip the serviceKey check specifically (see
// quota.js's allowsEmptyServiceKeyForTesting). /geocode/batch/email
// still requires a real email regardless -- that's the address the
// results actually get sent to, not just an account lookup key. Read at
// request time (like billing.js's isConfigured()), not cached at
// startup, so it can change without a restart. Never set this anywhere
// real customers' quota is at stake.
function allowsTestEmptyServiceKey() {
  return process.env.ALLOW_TEST_EMPTY_SERVICE_KEY === 'true';
}

// Gates the /road-alerts/test/weighted-points routes (see
// testWeightedPoints.js) -- off by default, same read-at-request-time
// spirit as allowsTestEmptyServiceKey() just above, for the same reason
// (can be flipped without a restart, and a real .env's setting is never
// picked up mid-test -- see helpers.js's withTestServer). Never enable
// this anywhere the "weighted points" wording could be mistaken for a
// real per-user routine store; it isn't one -- see the comment atop
// testWeightedPoints.js.
function allowsTestWeightedPoints() {
  return process.env.ALLOW_TEST_WEIGHTED_POINTS === 'true';
}

// Gates the /road-alerts/test/signals routes and their merge into
// GET /road-signals (see testRoadSignals.js) -- off by default, same
// read-at-request-time spirit as the two gates just above. Never enable
// this anywhere a real driver could mistake a fake, developer-seeded
// hazard for an actual live one.
function allowsTestRoadSignals() {
  return process.env.ALLOW_TEST_ROAD_SIGNALS === 'true';
}

// A client with no server-reachable filesystem path (e.g. a phone) sends the
// picked file's contents directly instead; fileContent takes priority when
// both are present since the client only sets one or the other.
function resolveAddresses(body) {
  const { filePath, fileContent } = body || {};
  return fileContent !== undefined ? readAddressContent(fileContent) : readAddressLines(filePath);
}

// Enforced read-only at the Postgres session level (see createReadOnlyPool
// in db.js); never add a write path against this pool (only usersDb is
// writable, via src/users.js).
const db = createReadOnlyPool(GEOCODING_DSN);
const usersDbPromise = openUsersDb(USERS_DSN).then(async (pool) => {
  await ensureFeedbackTable(pool);
  await ensureRoadAlertsAccountsTable(pool);
  await ensureRoadAlertsSurfacedLogTable(pool);
  await ensureRoadAlertsTopicsTable(pool);
  await ensureRoadAlertsStatementsTable(pool);
  await ensureTestWeightedPointsTable(pool);
  await ensureWeightedPointsTable(pool);
  await ensureTestRoadSignalsTable(pool);
  return pool;
});

const app = express();
app.use(cors());
// Only when actually running as the server (not when test/helpers.js's
// withTestServer requires this module) -- otherwise every test request
// across the whole suite would print a log line, drowning out real
// output. Goes to stdout; under systemd (see ops/geocoding-server.service)
// that's captured by journald automatically, no separate log file needed.
if (require.main === module) {
  app.use(morgan('combined'));
}
// batchGeocode.js has no cap on address count, but Express itself still
// needs some finite body-size ceiling for fileContent uploads (default
// 100kb is far too small). This is just that technical floor, not a
// business rule -- raise it further if a real batch ever needs to.
app.use(express.json({ limit: '200mb' }));

app.post('/geocode', async (req, res) => {
  const address = req.body && req.body.address;
  try {
    const result = await geocode(db, address, { offsetFeet: OFFSET_FEET });
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Quota is checked and consumed here the same way as /geocode/batch/email
// below -- both email and serviceKey must match an account (see
// users.js's generateServiceKey/verifyServiceKey) before quota is even
// looked at. Email alone used to be the only thing gating usage; a
// service key is what actually stops someone who merely knows an
// account's email from spending its quota.
app.post('/geocode/batch', async (req, res) => {
  const email = req.body && req.body.email;
  const serviceKey = req.body && req.body.serviceKey;
  const testMode = allowsTestEmptyServiceKey();
  const emailProvided = typeof email === 'string' && email.trim().length > 0;
  try {
    if ((!testMode || emailProvided) && (typeof email !== 'string' || !EMAIL_PATTERN.test(email))) {
      throw new ValidationError('email must be a valid email address');
    }
    if (!testMode && (typeof serviceKey !== 'string' || !serviceKey.trim())) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const addresses = resolveAddresses(req.body);

    if (!emailProvided) {
      // testMode with no email at all -- a pure smoke test, no
      // account/quota involved.
      const results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
      return res.json({ results });
    }

    const usersDb = await usersDbPromise;
    await checkQuota(usersDb, email, serviceKey, addresses.length);

    const results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
    await useQuota(usersDb, email, addresses.length);

    const current = await ensureCurrentPeriod(usersDb, await getUser(usersDb, email));
    res.json({
      results,
      usedThisPeriod: current.used_this_period,
      remaining: current.tier - current.used_this_period,
      tier: current.tier,
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/geocode/batch/download', async (req, res) => {
  const email = req.body && req.body.email;
  const serviceKey = req.body && req.body.serviceKey;
  const testMode = allowsTestEmptyServiceKey();
  const emailProvided = typeof email === 'string' && email.trim().length > 0;
  let results;
  let user = null;
  try {
    if ((!testMode || emailProvided) && (typeof email !== 'string' || !EMAIL_PATTERN.test(email))) {
      throw new ValidationError('email must be a valid email address');
    }
    if (!testMode && (typeof serviceKey !== 'string' || !serviceKey.trim())) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const addresses = resolveAddresses(req.body);

    if (emailProvided) {
      const usersDb = await usersDbPromise;
      user = await checkQuota(usersDb, email, serviceKey, addresses.length);
      results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
      await useQuota(usersDb, email, addresses.length);
    } else {
      // testMode with no email at all -- a pure smoke test, no
      // account/quota involved.
      results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
    }
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }

  const { successCsv, errorCsv } = resultsToCsv(results, req.body && req.body.ids);
  const zipBuffer = buildZip([
    { name: 'results.csv', content: successCsv },
    { name: 'errors.csv', content: errorCsv },
  ]);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="batch-geocode-results.zip"');
  if (user) {
    res.setHeader('X-Quota', `${user.used_this_period + results.length}/${user.tier}`);
  }
  res.send(zipBuffer);
});

app.post('/geocode/batch/email', async (req, res) => {
  const filePath = req.body && req.body.filePath;
  const email = req.body && req.body.email;
  const serviceKey = req.body && req.body.serviceKey;

  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (
      !allowsTestEmptyServiceKey() &&
      (typeof serviceKey !== 'string' || !serviceKey.trim())
    ) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const addresses = readAddressLines(filePath);
    const usersDb = await usersDbPromise;
    const user = await checkQuota(usersDb, email, serviceKey, addresses.length);

    const results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
    const { successCsv, errorCsv } = resultsToCsv(results);
    const zipBuffer = buildZip([
      { name: 'results.csv', content: successCsv },
      { name: 'errors.csv', content: errorCsv },
    ]);

    await useQuota(usersDb, email, addresses.length);
    const delivery = await sendResultsEmail(email, zipBuffer, { addressCount: addresses.length });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="batch-geocode-results.zip"');
    res.setHeader(
      'X-Quota',
      `${user.used_this_period + addresses.length}/${user.tier}`
    );
    res.setHeader('X-Email-Delivery', delivery.stubbed ? 'stubbed' : 'sent');
    res.send(zipBuffer);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Read-only quota lookup for a Plan & Quota screen: reports usage without
// gating anything (unlike checkQuota/useQuota in quota.js, which are tied
// to an actual batch-email send). There's no signup/login/session concept
// in this app, so the caller must supply the email to look up.
app.get('/quota', async (req, res) => {
  const email = req.query && req.query.email;
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'email must be a valid email address' });
  }

  const usersDb = await usersDbPromise;
  const user = await getUser(usersDb, email);
  if (!user) {
    return res.status(404).json({ error: `no active subscription found for ${email}` });
  }

  const current = await ensureCurrentPeriod(usersDb, user);
  res.json({
    email: current.email,
    tier: current.tier,
    usedThisPeriod: current.used_this_period,
    remaining: current.tier - current.used_this_period,
    periodStart: current.period_start,
  });
});

// Completes a bulk-geocoding purchase: the client already ran PayPal's
// approval flow and created the order, but deliberately never calls
// `actions.order.capture()` itself -- captureOrder() (billing.js) does
// the actual capture here, server-side, with the account's Client
// Secret. That's what actually confirms the money moved; trusting a
// client-reported "success" would let a tampered client claim a
// purchase happened without paying. Falls back to a no-op stub when
// PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET aren't configured. Price/
// addressCount are looked up server-side from pricing.js, never taken
// from the request body, so a client can't just claim a cheaper price
// for a bigger tier.
app.post('/billing/purchase', async (req, res) => {
  const { email, addressCount, orderId } = req.body || {};

  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof orderId !== 'string' || !orderId.trim()) {
      throw new ValidationError('orderId must be a non-empty string');
    }

    const tier = findTier(addressCount);
    if (!tier) {
      throw new ValidationError(`no pricing tier for ${addressCount} addresses`);
    }

    const capture = await captureOrder(orderId, {
      email,
      addressCount: tier.addressCount,
      priceCents: tier.priceCents,
    });

    const usersDb = await usersDbPromise;
    const user = await addToTier(usersDb, email, tier.addressCount);

    // The purchase itself has already succeeded (money captured, quota
    // granted) by this point -- an email hiccup shouldn't undo that or
    // fail the request, so its outcome is only reported, never thrown.
    const emailResult = await sendServiceKeyEmail(email, {
      serviceKey: user.service_key,
      tier: user.tier,
      purchased: tier.addressCount,
      priceCents: tier.priceCents,
    });

    res.json({
      email: user.email,
      tier: user.tier,
      usedThisPeriod: user.used_this_period,
      remaining: user.tier - user.used_this_period,
      periodStart: user.period_start,
      purchased: tier.addressCount,
      priceCents: tier.priceCents,
      stubbed: capture.stubbed,
      serviceKey: user.service_key,
      serviceKeyEmailed: emailResult.delivered,
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof PaymentError) return res.status(402).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Private comment/question intake -- there's no public listing or reply
// endpoint (see feedback.js), so this is one-way: a comment goes into
// Postgres and the site owner gets an email notification (falls back to
// a log-only stub without FEEDBACK_NOTIFY_EMAIL configured) and replies
// directly, outside the app, to whatever email the commenter left.
// `name` is unvalidated free text, not a verified identity -- a
// nickname or "anonymous" is fine.
const FEEDBACK_MESSAGE_MAX_LENGTH = 5000;
const FEEDBACK_NAME_MAX_LENGTH = 200;

app.post('/feedback', async (req, res) => {
  const { name, email, message } = req.body || {};
  try {
    if (typeof message !== 'string' || !message.trim()) {
      throw new ValidationError('message must be a non-empty string');
    }
    if (message.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
      throw new ValidationError(`message must be at most ${FEEDBACK_MESSAGE_MAX_LENGTH} characters`);
    }
    if (name !== undefined && name !== null && name !== '') {
      if (typeof name !== 'string' || name.length > FEEDBACK_NAME_MAX_LENGTH) {
        throw new ValidationError(`name must be a string of at most ${FEEDBACK_NAME_MAX_LENGTH} characters`);
      }
    }
    if (email !== undefined && email !== null && email !== '') {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address if provided');
      }
    }

    const usersDb = await usersDbPromise;
    await submitFeedback(usersDb, {
      name: name || null,
      email: email || null,
      message: message.trim(),
    });

    // Saved above regardless -- a notification hiccup shouldn't turn an
    // already-recorded comment into a failed request for the visitor.
    await sendFeedbackNotification({ name: name || null, email: email || null, message: message.trim() });

    res.json({ received: true });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/reverse-geocode', async (req, res) => {
  const { latitude, longitude } = req.body || {};
  try {
    const result = await reverseGeocode(db, latitude, longitude);
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Free-text place search (via the public Overpass API -- see
// placesSearch.js) near a point, returning whichever results have
// enough of an address to feed into batch geocoding. Not gated by
// quota/service key -- it doesn't touch geocoding_users or run any
// Meridian geocoding itself, just returns addresses a client could
// choose to run through /geocode/batch afterward.
app.post('/places/search', async (req, res) => {
  const { query, latitude, longitude, radiusMeters } = req.body || {};
  try {
    const result = await searchPlaces(query, latitude, longitude, radiusMeters);
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof UpstreamError) return res.status(502).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Registers (or re-registers) a Road Alerts account -- email only, no
// password, matching this app's existing loose account model (see
// roadAlertsAccounts.js). Idempotent: an already-registered email gets
// its existing service key back unchanged, re-emailed -- this is
// deliberately this feature's only "forgot my key" recovery path, since
// there's no separate recovery flow anywhere in this app. Free for every
// registered account right now, no trial clock -- see
// roadAlertsAccounts.js's registerAccount for why.
app.post('/road-alerts/register', async (req, res) => {
  const { email } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    const usersDb = await usersDbPromise;
    const account = await registerAccount(usersDb, email);

    const emailResult = await sendRoadAlertsWelcomeEmail(email, {
      serviceKey: account.service_key,
      alreadyRegistered: !account.created,
    });

    res.json({
      email: account.email,
      serviceKey: account.service_key,
      registeredAt: account.registered_at,
      alreadyRegistered: !account.created,
      serviceKeyEmailed: emailResult.delivered,
      digestOptIn: account.digest_opt_in,
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Reads/writes an account's opt-in flag for the daily email digest (see
// roadAlertsDigest.js) -- separate from /road-alerts/register since the
// app loads a stored account straight from device storage on launch
// (see roadAlertsStorage.ts), with no other way to learn the current
// server-side value after a restart. GET only returns what
// checkRoadAlertsAccess already fetched; POST updates it. Default is
// false for every account -- the digest is opt-in, never automatic.
app.get('/road-alerts/preferences', async (req, res) => {
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

    res.json({ digestOptIn: account.digest_opt_in });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/road-alerts/preferences', async (req, res) => {
  const { email, serviceKey, digestOptIn } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }
    if (typeof digestOptIn !== 'boolean') {
      throw new ValidationError('digestOptIn must be a boolean');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);
    const account = await updateDigestOptIn(usersDb, email, digestOptIn);

    res.json({ digestOptIn: account.digest_opt_in });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// A display name shown alongside anything an account posts (see
// roadAlertsStatements.js) -- kept separate from /road-alerts/register
// (that route's contract is specifically email-only account creation/
// key-recovery, already asserted by its own tests) and from
// /road-alerts/preferences (specifically the digest boolean). Same
// reasoning as preferences for being its own GET/POST pair: a stored
// account on-device carries no profile data of its own (see
// roadAlertsStorage.ts), so the current value is always fetched fresh.
app.get('/road-alerts/username', async (req, res) => {
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

    res.json({ username: account.username });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/road-alerts/username', async (req, res) => {
  const { email, serviceKey, username } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';
    if (!trimmedUsername || trimmedUsername.length > 40) {
      throw new ValidationError('username must be 1-40 characters');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);
    const account = await updateUsername(usersDb, email, trimmedUsername);

    res.json({ username: account.username });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// The topic (if any) anchored to a road location, and everything
// posted to it -- see roadAlertsTopics.js for why a topic is anchored
// to a persistent street segment (tlid) rather than to a volatile 511
// signal.id. Read-only: uses findTopic, never findOrCreateTopic, so
// merely viewing an alert never creates a topic nobody's actually
// commented on. `db` (read-only, the `geocoding` streets database) is
// used only to resolve the tlid; the topic/statement lookup itself
// runs against `usersDb` (`geocoding_users`, writable).
app.get('/road-alerts/topic', async (req, res) => {
  const { latitude, longitude, email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new ValidationError('latitude and longitude must be numbers');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const tlid = await resolveTlid(db, lat, lon);
    const topic = await findTopic(usersDb, { tlid, latitude: lat, longitude: lon });
    if (!topic) {
      return res.json({ topic: null, statements: [] });
    }

    const statements = await getStatementsForTopic(usersDb, topic.id);
    res.json({
      topic: {
        id: topic.id,
        tlid: topic.tlid,
        latitude: topic.latitude,
        longitude: topic.longitude,
        roadway: topic.roadway,
        createdAt: topic.created_at,
      },
      statements: statements.map((statement) => ({
        id: statement.id,
        username: statement.username,
        body: statement.body,
        createdAt: statement.created_at,
        replies: statement.replies.map((reply) => ({
          id: reply.id,
          username: reply.username,
          body: reply.body,
          createdAt: reply.created_at,
          replies: [],
        })),
      })),
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Posts a top-level statement on the topic anchored to a location (the
// only write path that can create a topic -- see roadAlertsTopics.js),
// or a reply to an existing statement when parentStatementId is given.
// The one-level-cap enforcement itself lives in insertStatement
// (roadAlertsStatements.js), not here -- this route only decides
// whether a topic needs resolving/creating first.
app.post('/road-alerts/statements', async (req, res) => {
  const { email, serviceKey, body, latitude, longitude, roadway, parentStatementId } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }
    const trimmedBody = typeof body === 'string' ? body.trim() : '';
    if (!trimmedBody || trimmedBody.length > 500) {
      throw new ValidationError('body must be 1-500 characters');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
    if (!account.username) {
      throw new ValidationError('set a display name before posting a comment');
    }

    let topicId;
    if (parentStatementId != null) {
      // A reply's topic comes from its parent, never from the client --
      // latitude/longitude are ignored here, so a reply always lands on
      // the same topic as the statement it's replying to.
      const parent = await getStatement(usersDb, parentStatementId);
      if (!parent) {
        throw new NotFoundError(`no statement found with id ${parentStatementId}`);
      }
      topicId = parent.topic_id;
    } else {
      const lat = Number(latitude);
      const lon = Number(longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new ValidationError('latitude and longitude must be numbers for a new statement');
      }
      const tlid = await resolveTlid(db, lat, lon);
      const topic = await findOrCreateTopic(usersDb, {
        tlid,
        latitude: lat,
        longitude: lon,
        roadway: typeof roadway === 'string' ? roadway : null,
      });
      topicId = topic.id;
    }

    const statement = await insertStatement(usersDb, {
      topicId,
      parentStatementId: parentStatementId ?? null,
      email: account.email,
      username: account.username,
      body: trimmedBody,
    });

    res.json({
      statement: {
        id: statement.id,
        topicId: statement.topic_id,
        parentStatementId: statement.parent_statement_id,
        username: statement.username,
        body: statement.body,
        createdAt: statement.created_at,
      },
      topicId,
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// How many replies to this account's own statements are unseen -- see
// roadAlertsStatements.js's getUnseenReplyCount for the "only counts a
// reply from someone else, never a self-reply" rule. This is
// deliberately scoped to replies only, not a general "new alerts" count
// -- see AGENTS.md's Road Alerts section for why: that would need
// tracking every alert *surfaced* to a user (a passive-exposure event),
// which cuts against this project's explicit-action-only logging
// principle for Road Alerts, established while building the digest
// feature.
app.get('/road-alerts/notifications', async (req, res) => {
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const sinceDate = account.notifications_viewed_at ?? account.registered_at;
    const replyCount = await getUnseenReplyCount(usersDb, email, sinceDate);

    res.json({ replyCount });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Resets the reply count above to 0 -- called when the driver actually
// opens/expands their notifications, not on every poll.
app.post('/road-alerts/notifications/viewed', async (req, res) => {
  const { email, serviceKey } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);
    const account = await markNotificationsViewed(usersDb, email);

    res.json({ viewedAt: account.notifications_viewed_at });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Live traffic-hazard incidents near a point, sourced from New England 511
// (Maine/NH/Vermont DOTs -- see roadSignals.js and docs/ROAD_ALERTS_DESIGN.md).
// GET, not POST, since it's polled repeatedly with no free-text body to
// send, same convention as GET /quota. Requires a registered Road Alerts
// account (email+serviceKey, see roadAlertsAccounts.js) -- checked before
// the upstream 511 fetch, so a bad request never burns an upstream call.
app.get('/road-signals', async (req, res) => {
  const { latitude, longitude, radiusMeters, email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const parsedLatitude = latitude !== undefined ? Number(latitude) : undefined;
    const parsedLongitude = longitude !== undefined ? Number(longitude) : undefined;
    const parsedRadiusMeters = radiusMeters !== undefined ? Number(radiusMeters) : 8000;

    // Test-only fake hazards (see testRoadSignals.js) merged in alongside
    // the real live ones -- off by default (allowsTestRoadSignals()).
    // Caught separately from the real fetch below: if 511 itself is down,
    // a developer testing against their own seeded hazard shouldn't also
    // lose that because of an unrelated upstream outage.
    let testSignals = [];
    if (allowsTestRoadSignals()) {
      try {
        const allTestSignals = await getTestRoadSignals(usersDb, email);
        testSignals =
          parsedLatitude !== undefined && parsedLongitude !== undefined
            ? filterByBbox(allTestSignals, parsedLatitude, parsedLongitude, parsedRadiusMeters)
            : allTestSignals;
      } catch (err) {
        console.error('Failed to load test road signals:', err);
      }
    }

    let result;
    try {
      result = await getRoadSignals({
        latitude: parsedLatitude,
        longitude: parsedLongitude,
        radiusMeters: parsedRadiusMeters,
      });
    } catch (err) {
      if (testSignals.length === 0) throw err;
      result = { signals: [], networks: [], partial: true, failedNetworks: [], generatedAt: new Date().toISOString() };
    }

    if (testSignals.length > 0) {
      result = { ...result, signals: sortByFreshness([...result.signals, ...testSignals]) };
    }

    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof UpstreamError) return res.status(502).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// "Which street should I turn onto to get off this road before reaching
// the hazard ahead" -- a proximity approximation using the existing
// `streets` table (see nextCrossStreet.js), not real routing. On-demand
// only (the mobile client calls this once per alert the driver taps,
// never auto-polled) -- gated by the same registered-account check as
// /road-signals since it's part of the same product. The hazard's own
// latitude/longitude/roadway are passed in by the client from the
// RoadSignal it already has; this route never re-fetches 511 itself.
app.get('/road-signals/cross-street', async (req, res) => {
  const { driverLatitude, driverLongitude, hazardLatitude, hazardLongitude, hazardRoadway, email, serviceKey } =
    req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const result = await findNextCrossStreet(db, {
      driverLatitude: driverLatitude !== undefined ? Number(driverLatitude) : undefined,
      driverLongitude: driverLongitude !== undefined ? Number(driverLongitude) : undefined,
      hazardLatitude: hazardLatitude !== undefined ? Number(hazardLatitude) : undefined,
      hazardLongitude: hazardLongitude !== undefined ? Number(hazardLongitude) : undefined,
      hazardRoadway: typeof hazardRoadway === 'string' ? hazardRoadway : null,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// 1-2 alternate driving routes past the hazard, avoiding a buffer around
// it -- see roadReroute.js for the rejoin-point estimate and the
// pgRouting/pgr_ksp query against our own `streets`-derived topology
// (streets_topology_nodes/streets_routing_edges, built by
// routing_topology.py) -- no external routing service. Same
// client-resends-the-hazard's-own-coordinates reasoning as
// /road-signals/cross-street above.
app.get('/road-signals/reroute', async (req, res) => {
  const { driverLatitude, driverLongitude, driverHeading, hazardLatitude, hazardLongitude, email, serviceKey } =
    req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const result = await getRoadReroute(db, {
      driverLatitude: driverLatitude !== undefined ? Number(driverLatitude) : undefined,
      driverLongitude: driverLongitude !== undefined ? Number(driverLongitude) : undefined,
      driverHeading: driverHeading !== undefined ? Number(driverHeading) : undefined,
      hazardLatitude: hazardLatitude !== undefined ? Number(hazardLatitude) : undefined,
      hazardLongitude: hazardLongitude !== undefined ? Number(hazardLongitude) : undefined,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Emails one road alert to the account's own registered email, on
// request -- the "save this" voice command in RoadAlertsForm.tsx, or any
// other on-demand save. The `signal` is passed in by the client from the
// RoadSignal it already has (same reasoning as /road-signals/cross-street
// just above: this route never re-fetches 511 itself). Always sends to
// the authenticated account's own email (from checkRoadAlertsAccess, tied
// to the email+serviceKey pair) -- never an arbitrary address the client
// names, so there's no open-relay/spam surface here beyond a user
// emailing themselves.
app.post('/road-alerts/email-alert', async (req, res) => {
  const { email, serviceKey, signal } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }
    if (!signal || typeof signal !== 'object' || typeof signal.id !== 'string') {
      throw new ValidationError('signal must be a road signal object with an id');
    }
    if (!signal.speech || typeof signal.speech.deep !== 'string') {
      throw new ValidationError('signal.speech.deep must be a string');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const emailResult = await sendRoadAlertEmail(email, signal);

    // Logging into the digest is purely additive to the immediate send
    // above, and only for accounts opted in -- see roadAlertsSurfacedLog.js.
    // A logging failure shouldn't fail a request the user is already
    // mid-voice-command for, so it's caught and reported here rather than
    // thrown.
    if (account.digest_opt_in) {
      try {
        await insertSurfacedAlert(usersDb, email, signal);
      } catch (logErr) {
        console.error('failed to log surfaced alert for digest:', logErr);
      }
    }

    res.json({ emailed: emailResult.delivered, stubbed: Boolean(emailResult.stubbed) });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Test-only fake weighted points (see testWeightedPoints.js) -- off by
// default (allowsTestWeightedPoints(), checked first so a disabled
// deployment never even touches the database for these). Gated by the
// same registered-account check as /road-signals otherwise. Lets a real
// device's live GPS and real 511 data be run through
// roadAlertsMatching.js's "hazard between the user and a routine point"
// logic without needing the on-device trip-learning system that would
// eventually produce real weighted points -- never a substitute for that
// real, on-device-only data.
app.post('/road-alerts/test/weighted-points', async (req, res) => {
  if (!allowsTestWeightedPoints()) {
    return res.status(404).json({ error: 'not found' });
  }
  const { email, serviceKey, latitude, longitude, weight, tlid, label } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const point = await addTestWeightedPoint(usersDb, email, {
      latitude: typeof latitude === 'number' ? latitude : Number(latitude),
      longitude: typeof longitude === 'number' ? longitude : Number(longitude),
      weight: typeof weight === 'number' ? weight : Number(weight),
      tlid: typeof tlid === 'string' ? tlid : null,
      label: typeof label === 'string' ? label : null,
    });

    res.json(point);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/road-alerts/test/weighted-points', async (req, res) => {
  if (!allowsTestWeightedPoints()) {
    return res.status(404).json({ error: 'not found' });
  }
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const weightedPoints = await getTestWeightedPoints(usersDb, email);
    res.json({ weightedPoints });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/road-alerts/test/weighted-points', async (req, res) => {
  if (!allowsTestWeightedPoints()) {
    return res.status(404).json({ error: 'not found' });
  }
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const deleted = await clearTestWeightedPoints(usersDb, email);
    res.json({ deleted });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Real weighted points (see weightedPoints.js) -- unlike the /test/
// routes above, always on for any registered Road Alerts account, no
// env-var gate. The mobile app calls this periodically with its current
// position while a monitoring session is active, *except* for the
// session's first and last ping (its trip endpoints) -- see
// weightedPoints.js's own doc comment for why those are excluded rather
// than just weighted low.
app.post('/road-alerts/weighted-points', async (req, res) => {
  const { email, serviceKey, latitude, longitude, tlid, isEndpoint } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const point = await recordWeightedPointPing(usersDb, email, {
      latitude: typeof latitude === 'number' ? latitude : Number(latitude),
      longitude: typeof longitude === 'number' ? longitude : Number(longitude),
      tlid: typeof tlid === 'string' ? tlid : null,
      isEndpoint: Boolean(isEndpoint),
    });

    res.json({ point });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/road-alerts/weighted-points', async (req, res) => {
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const weightedPoints = await getWeightedPoints(usersDb, email);
    res.json({ weightedPoints });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Test-only fake hazards (see testRoadSignals.js) -- off by default
// (allowsTestRoadSignals(), checked first so a disabled deployment never
// even touches the database for these). Gated by the same registered-
// account check as /road-signals otherwise. Unlike a real 511 incident,
// a row here never expires on its own -- lets a developer keep testing
// the map/comments/reroute UI against a stable hazard for as long as
// they want, across as many days as they want, without depending on a
// real hazard staying live (or staying in range) that whole time.
app.post('/road-alerts/test/signals', async (req, res) => {
  if (!allowsTestRoadSignals()) {
    return res.status(404).json({ error: 'not found' });
  }
  const { email, serviceKey, latitude, longitude, roadway, description, severity } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const row = await addTestRoadSignal(usersDb, email, {
      latitude: typeof latitude === 'number' ? latitude : Number(latitude),
      longitude: typeof longitude === 'number' ? longitude : Number(longitude),
      roadway: typeof roadway === 'string' ? roadway : null,
      description: typeof description === 'string' ? description : null,
      severity: typeof severity === 'string' ? severity : undefined,
    });

    res.json(row);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/road-alerts/test/signals', async (req, res) => {
  if (!allowsTestRoadSignals()) {
    return res.status(404).json({ error: 'not found' });
  }
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const signals = await getTestRoadSignals(usersDb, email);
    res.json({ signals });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/road-alerts/test/signals', async (req, res) => {
  if (!allowsTestRoadSignals()) {
    return res.status(404).json({ error: 'not found' });
  }
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    await checkRoadAlertsAccess(usersDb, email, serviceKey);

    const deleted = await clearTestRoadSignals(usersDb, email);
    res.json({ deleted });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`geocoding-server listening on http://localhost:${PORT}`);
    console.log(`using database: ${GEOCODING_DSN}`);
    if (allowsTestEmptyServiceKey()) {
      console.warn(
        '⚠ ALLOW_TEST_EMPTY_SERVICE_KEY is set -- batch geocoding accepts an empty ' +
          'service key for ANY known email. Never enable this where real customers’ ' +
          'quota is at stake.'
      );
    }
    if (allowsTestWeightedPoints()) {
      console.warn(
        '⚠ ALLOW_TEST_WEIGHTED_POINTS is set -- /road-alerts/test/weighted-points is ' +
          'live. These are fake, developer-seeded routine points for testing only, ' +
          'never a real per-user routine store.'
      );
    }
    if (allowsTestRoadSignals()) {
      console.warn(
        '⚠ ALLOW_TEST_ROAD_SIGNALS is set -- /road-alerts/test/signals is live and ' +
          'GET /road-signals will merge in fake, developer-seeded hazards. These never ' +
          'expire on their own -- never enable this where a real driver could see one.'
      );
    }
  });
}

module.exports = { app, db, usersDbPromise };
