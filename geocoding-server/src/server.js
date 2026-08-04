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
const { checkQuota, useQuota } = require('./quota');
const { sendResultsEmail } = require('./emailDelivery');
const { findTier } = require('./pricing');
const { captureOrder } = require('./billing');
const {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
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
const usersDbPromise = openUsersDb(USERS_DSN);

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

app.post('/geocode/batch', async (req, res) => {
  try {
    const addresses = resolveAddresses(req.body);
    const results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
    res.json({ results });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/geocode/batch/download', async (req, res) => {
  let results;
  try {
    const addresses = resolveAddresses(req.body);
    results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
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
  res.send(zipBuffer);
});

app.post('/geocode/batch/email', async (req, res) => {
  const filePath = req.body && req.body.filePath;
  const email = req.body && req.body.email;

  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }

    const addresses = readAddressLines(filePath);
    const usersDb = await usersDbPromise;
    const user = await checkQuota(usersDb, email, addresses.length);

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
// real client-side approval flow (a real order exists, in sandbox), and
// hands us that order's id. captureOrder() is a deliberate stub (see
// billing.js) -- it doesn't verify anything with PayPal, so the tier
// bump below happens unconditionally. Price/addressCount are looked up
// server-side from pricing.js, never taken from the request body, so a
// client can't just claim a cheaper price for a bigger tier.
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

    await captureOrder(orderId, {
      email,
      addressCount: tier.addressCount,
      priceCents: tier.priceCents,
    });

    const usersDb = await usersDbPromise;
    const user = await addToTier(usersDb, email, tier.addressCount);
    res.json({
      email: user.email,
      tier: user.tier,
      usedThisPeriod: user.used_this_period,
      remaining: user.tier - user.used_this_period,
      periodStart: user.period_start,
      purchased: tier.addressCount,
      priceCents: tier.priceCents,
      stubbed: true,
    });
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
  });
}

module.exports = { app, db, usersDbPromise };
