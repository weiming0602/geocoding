require('dotenv').config();

const express = require('express');
const cors = require('cors');
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
const { openUsersDb, getUser, ensureCurrentPeriod, addToTier } = require('./users');
const { ensureFeedbackTable, submitFeedback } = require('./feedback');
const { checkQuota, useQuota } = require('./quota');
const { sendResultsEmail, sendServiceKeyEmail, sendFeedbackNotification } = require('./emailDelivery');
const { findTier } = require('./pricing');
const { captureOrder } = require('./billing');
const {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
  PaymentError,
  UnauthorizedError,
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
// See quota.js's allowsEmptyServiceKeyForTesting -- lets an empty
// serviceKey through validation so checkQuota can decide whether to
// accept it. Read at request time (like billing.js's isConfigured()),
// not cached at startup, so it can change without a restart. Never set
// this anywhere real customers' quota is at stake.
function allowsTestEmptyServiceKey() {
  return process.env.ALLOW_TEST_EMPTY_SERVICE_KEY === 'true';
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
  return pool;
});

const app = express();
app.use(cors());
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

    const addresses = resolveAddresses(req.body);
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
  let results;
  let user;
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

    const addresses = resolveAddresses(req.body);
    const usersDb = await usersDbPromise;
    user = await checkQuota(usersDb, email, serviceKey, addresses.length);

    results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
    await useQuota(usersDb, email, addresses.length);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }

  const { successCsv, errorCsv } = resultsToCsv(results);
  const zipBuffer = buildZip([
    { name: 'results.csv', content: successCsv },
    { name: 'errors.csv', content: errorCsv },
  ]);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="batch-geocode-results.zip"');
  res.setHeader('X-Quota', `${user.used_this_period + results.length}/${user.tier}`);
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
  });
}

module.exports = { app, db, usersDbPromise };
