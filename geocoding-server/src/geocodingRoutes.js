const { geocode } = require('./geocode');
const { geocodeAddressList, readAddressLines, readAddressContent } = require('./batchGeocode');
const { batchLlmAssist } = require('./llmAssist');
const { resultsToCsv } = require('./resultsCsv');
const { buildZip } = require('./zip');
const { reverseGeocode } = require('./reverseGeocode');
const { searchPlaces } = require('./placesSearch');
const { getUser, ensureCurrentPeriod, addToTier } = require('./users');
const { submitFeedback } = require('./feedback');
const { recordTransaction, listTransactions, markTransactionsNotified } = require('./transactions');
const { checkQuota, useQuota } = require('./quota');
const { checkRateLimit } = require('./geocodeRateLimit');
const {
  sendResultsEmail,
  sendServiceKeyEmail,
  sendFeedbackNotification,
  sendTransactionsDigestEmail,
  sendBatchRunNotification,
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
  RateLimitError,
} = require('./errors');
const { EMAIL_PATTERN, allowsTestEmptyServiceKey } = require('./serverSetup');

// The paid geocoding product's routes: single/batch/reverse geocoding,
// quota, billing, Find Places, feedback, and the owner dashboard. Served
// by geocodingServer.js on its own in production (and by server.js
// alongside roadAlertsRoutes.js everywhere else) -- see serverSetup.js.

const OFFSET_FEET = Number(process.env.OFFSET_FEET) || 20;

// A client with no server-reachable filesystem path (e.g. a phone) sends the
// picked file's contents directly instead; fileContent takes priority when
// both are present since the client only sets one or the other.
function resolveAddresses(body) {
  const { filePath, fileContent } = body || {};
  return fileContent !== undefined ? readAddressContent(fileContent) : readAddressLines(filePath);
}

/** Registers every geocoding route on `app`. `db` is the read-only geocoding pool. */
function registerGeocodingRoutes(app, { db, usersDbPromise }) {
  app.post('/geocode', async (req, res) => {
    const address = req.body && req.body.address;
    const email = req.body && req.body.email;
    const serviceKey = req.body && req.body.serviceKey;
    const authenticated = typeof email === 'string' && email.trim().length > 0;
    try {
      let usersDb;
      if (authenticated) {
        usersDb = await usersDbPromise;
        await checkQuota(usersDb, email, serviceKey, 1);
      } else {
        // This path never touched geocoding_users before this feature existed --
        // an outage there shouldn't take down the site's own free lookup pages.
        // Fail open on anything that isn't a deliberate RateLimitError.
        try {
          usersDb = await usersDbPromise;
          await checkRateLimit(usersDb, req.ip);
        } catch (err) {
          if (err instanceof RateLimitError) throw err;
          console.error('rate limit check failed, failing open for this request', err);
        }
      }

      const result = await geocode(db, address, {
        offsetFeet: OFFSET_FEET,
        llmAssist: authenticated ? { usersDb, email } : null,
      });

      if (authenticated) {
        await useQuota(usersDb, email, 1);
      }
      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
      if (err instanceof RateLimitError) return res.status(429).json({ error: err.message });
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

      // A real, paid run: rows that aren't found get an LLM-assisted retry
      // (see batchGeocode.js). The smoke-test branch above never does.
      const results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET, llmAssist: batchLlmAssist(usersDb, email) });
      await useQuota(usersDb, email, addresses.length);

      // Only reached once a real account's quota has actually been spent
      // -- never for the emailProvided-false smoke-test branch above,
      // which returns before this point.
      await sendBatchRunNotification({
        email,
        addressCount: addresses.length,
        successCount: results.filter((r) => r.success).length,
        llmCorrectedCount: results.filter((r) => r.source === 'llm_assisted').length,
        source: 'batch',
      });

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
        results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET, llmAssist: batchLlmAssist(usersDb, email) });
        await useQuota(usersDb, email, addresses.length);
        await sendBatchRunNotification({
          email,
          addressCount: addresses.length,
          successCount: results.filter((r) => r.success).length,
        llmCorrectedCount: results.filter((r) => r.source === 'llm_assisted').length,
          source: 'batch/download',
        });
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

      const results = await geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET, llmAssist: batchLlmAssist(usersDb, email) });
      const { successCsv, errorCsv } = resultsToCsv(results);
      const zipBuffer = buildZip([
        { name: 'results.csv', content: successCsv },
        { name: 'errors.csv', content: errorCsv },
      ]);

      await useQuota(usersDb, email, addresses.length);
      await sendBatchRunNotification({
        email,
        addressCount: addresses.length,
        successCount: results.filter((r) => r.success).length,
        llmCorrectedCount: results.filter((r) => r.source === 'llm_assisted').length,
        source: 'batch/email',
      });
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

      // Same "already succeeded, don't undo it" reasoning as the email
      // send just below -- a real financial record of this purchase
      // matters more than any downstream step failing, so it's recorded
      // right after the quota grant, before the (best-effort) email send.
      const transactionRow = await recordTransaction(usersDb, {
        email: user.email,
        orderId,
        addressCount: tier.addressCount,
        priceCents: tier.priceCents,
        tier: user.tier,
      });

      // Notifies the owner immediately, same pattern as
      // sendFeedbackNotification -- not just the periodic
      // scripts/transactions-digest.js run. Reuses that same send function
      // (it already handles a single-transaction array correctly) and
      // marks the row notified the same way transactionsDigest.js's own
      // runDailyTransactionsDigest does (delivered OR stubbed both count
      // as "handled" -- only a genuine failure leaves it pending), so that
      // script's own getUnnotifiedTransactions query normally has nothing
      // left to do here; it's still the safety net for a transaction whose
      // immediate send genuinely failed (Resend down, etc.).
      const ownerNotifyResult = await sendTransactionsDigestEmail([transactionRow]);
      if (ownerNotifyResult.delivered || ownerNotifyResult.stubbed) {
        await markTransactionsNotified(usersDb, [transactionRow.id]);
      }

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

  // Owner/manager-only view of completed purchases (ui/desktop's
  // unlisted /admin/transactions page, reached only by direct URL -- it
  // deliberately has no NAV_ENTRIES link, unlike every real feature page).
  // There's no login system anywhere in this app (see CLAUDE.md), so this
  // reuses the simplest thing that already exists here -- a shared secret
  // checked on every request, same trust model as a batch service key --
  // rather than building real accounts/roles just for one admin page.
  // ADMIN_PASSCODE must be set for this to ever succeed: with it unset,
  // every request is rejected (never "misconfigured, so let it through").
  app.get('/admin/transactions', async (req, res) => {
    const passcode = req.query && req.query.passcode;
    try {
      if (
        typeof passcode !== 'string' ||
        !process.env.ADMIN_PASSCODE ||
        passcode !== process.env.ADMIN_PASSCODE
      ) {
        throw new UnauthorizedError('passcode is missing or incorrect');
      }

      const usersDb = await usersDbPromise;
      const transactions = await listTransactions(usersDb);
      res.json({
        transactions: transactions.map((t) => ({
          id: t.id,
          email: t.email,
          orderId: t.order_id,
          addressCount: t.address_count,
          priceCents: t.price_cents,
          tier: t.tier,
          createdAt: t.created_at,
        })),
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/reverse-geocode', async (req, res) => {
    const { latitude, longitude } = req.body || {};
    const email = req.body && req.body.email;
    const serviceKey = req.body && req.body.serviceKey;
    const authenticated = typeof email === 'string' && email.trim().length > 0;
    try {
      let usersDb;
      if (authenticated) {
        usersDb = await usersDbPromise;
        await checkQuota(usersDb, email, serviceKey, 1);
      } else {
        // This path never touched geocoding_users before this feature existed --
        // an outage there shouldn't take down the site's own free lookup pages.
        // Fail open on anything that isn't a deliberate RateLimitError.
        try {
          usersDb = await usersDbPromise;
          await checkRateLimit(usersDb, req.ip);
        } catch (err) {
          if (err instanceof RateLimitError) throw err;
          console.error('rate limit check failed, failing open for this request', err);
        }
      }

      const result = await reverseGeocode(db, latitude, longitude);

      if (authenticated) {
        await useQuota(usersDb, email, 1);
      }
      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
      if (err instanceof RateLimitError) return res.status(429).json({ error: err.message });
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
}

module.exports = { registerGeocodingRoutes };
