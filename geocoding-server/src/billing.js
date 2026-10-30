const crypto = require('node:crypto');

const { PaymentError, ValidationError } = require('./errors');
const { findTier } = require('./pricing');

// Stripe Checkout (Stripe's hosted payment page), via plain authenticated
// `fetch` calls -- no SDK dependency, same as emailDelivery.js's Resend
// integration. Falls back to a stub whenever STRIPE_SECRET_KEY isn't set,
// same pattern as emailDelivery.js. Sandbox vs. live is decided entirely
// by which key is set (`sk_test_...` vs. `sk_live_...`) -- there's no
// separate base URL to switch, unlike PayPal's.
//
// Unlike the PayPal flow this replaced, the *server* creates the payment
// (createCheckoutSession), with the amount taken from pricing.js -- the
// client never names a price at all, so there's no client-created order
// whose amount has to be cross-checked afterward. The tier is carried on
// the session's own `metadata`, set here and never by the client.
const STRIPE_API_BASE = process.env.STRIPE_API_BASE || 'https://api.stripe.com';

// How old a webhook's signed timestamp may be before it's rejected as a
// possible replay -- Stripe's own SDKs default to the same 5 minutes.
const WEBHOOK_TOLERANCE_SECONDS = 300;

// Stub session ids carry the purchase in the id itself (there's no Stripe
// session to look the metadata up on) -- only ever minted and accepted
// while STRIPE_SECRET_KEY is unset.
const STUB_SESSION_PREFIX = 'cs_stub_';

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function isWebhookConfigured() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

async function stripeRequest(method, path, params) {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new PaymentError(`Stripe request failed: ${body.error?.message || response.status}`);
  }
  return body;
}

// Stripe substitutes the literal `{CHECKOUT_SESSION_ID}` in success_url
// itself. The return URL is usually a hash route (`.../#/checkout`), so the
// query string goes after the hash, where the app's router reads it.
function withQuery(url, query) {
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/**
 * Creates a Checkout Session for `tier`, returning `{ sessionId, url,
 * stubbed }` -- the client just redirects to `url`. Stripe sends the
 * browser back to `returnUrl` with `session_id=...` (paid) or
 * `canceled=1` (backed out) appended.
 */
async function createCheckoutSession({ email, tier, returnUrl }) {
  if (!isConfigured()) {
    const sessionId =
      `${STUB_SESSION_PREFIX}${tier.addressCount}_` +
      `${Buffer.from(email).toString('base64url')}_${crypto.randomBytes(8).toString('hex')}`;
    console.log(
      `[billing stub] would create a Stripe Checkout Session for ${email}: ` +
        `${tier.addressCount} addresses, $${(tier.priceCents / 100).toFixed(2)}`
    );
    return { sessionId, url: withQuery(returnUrl, `session_id=${sessionId}`), stubbed: true };
  }

  const session = await stripeRequest('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    customer_email: email,
    success_url: withQuery(returnUrl, 'session_id={CHECKOUT_SESSION_ID}'),
    cancel_url: withQuery(returnUrl, 'canceled=1'),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(tier.priceCents),
    'line_items[0][price_data][product_data][name]':
      `Meridian batch geocoding: ${tier.addressCount.toLocaleString('en-US')} addresses/month`,
    'metadata[email]': email,
    'metadata[addressCount]': String(tier.addressCount),
  });
  return { sessionId: session.id, url: session.url, stubbed: false };
}

/**
 * Turns a Checkout Session object (fetched from Stripe, or delivered by a
 * webhook) into the purchase it paid for, throwing PaymentError unless it
 * was actually paid for the tier its metadata names. The amount check is
 * defense in depth -- createCheckoutSession set both from the same tier,
 * so a mismatch would mean something other than this server made it.
 */
function paidPurchaseFromSession(session) {
  // A delayed payment method (e.g. a US bank account) finishes checkout
  // before the money arrives -- the webhook's
  // checkout.session.async_payment_succeeded grants the quota once it does.
  if (session.status === 'complete' && session.payment_status === 'unpaid') {
    throw new PaymentError(
      "Your payment is still processing. Your quota will be added and your service key emailed once it clears (usually within a few business days)."
    );
  }
  if (session.payment_status !== 'paid') {
    throw new PaymentError(`Stripe session ${session.id} is not paid (status: ${session.payment_status})`);
  }
  const email = session.metadata?.email;
  const tier = findTier(Number(session.metadata?.addressCount));
  if (!email || !tier) {
    throw new PaymentError(`Stripe session ${session.id} has no Meridian purchase metadata`);
  }
  if (session.currency !== 'usd' || session.amount_total !== tier.priceCents) {
    throw new PaymentError(
      `Stripe session ${session.id} paid ${session.amount_total} ${session.currency}, ` +
        `not the ${tier.addressCount}-address tier's ${tier.priceCents} usd`
    );
  }
  return { sessionId: session.id, email, tier, stubbed: false };
}

/** Looks up a returning browser's session id and confirms it was paid -- see paidPurchaseFromSession. */
async function retrievePaidPurchase(sessionId) {
  if (!isConfigured()) {
    const match = new RegExp(`^${STUB_SESSION_PREFIX}(\\d+)_([A-Za-z0-9_-]+)_[0-9a-f]+$`).exec(sessionId);
    const tier = match && findTier(Number(match[1]));
    if (!tier) throw new ValidationError('not a valid checkout session id');
    const email = Buffer.from(match[2], 'base64url').toString();
    return { sessionId, email, tier, stubbed: true };
  }
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    throw new ValidationError('not a valid checkout session id');
  }
  return paidPurchaseFromSession(
    await stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`)
  );
}

/**
 * Verifies a webhook's `Stripe-Signature` header against the raw request
 * body (Stripe's documented scheme: HMAC-SHA256 of `${t}.${body}` with the
 * endpoint's signing secret, compared against each `v1=` value) and
 * returns the parsed event, or throws PaymentError. Must be the raw bytes
 * Stripe sent -- re-serializing parsed JSON wouldn't match the signature.
 */
function verifyWebhookEvent(rawBody, signatureHeader, { now = Date.now() } = {}) {
  const parts = String(signatureHeader || '')
    .split(',')
    .map((part) => part.split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length) {
    throw new PaymentError('missing or malformed Stripe-Signature header');
  }

  const expected = crypto
    .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  const matches = signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!matches) {
    throw new PaymentError('Stripe webhook signature does not match');
  }
  if (Math.abs(now / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new PaymentError('Stripe webhook timestamp is outside the allowed tolerance');
  }
  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = {
  isWebhookConfigured,
  createCheckoutSession,
  retrievePaidPurchase,
  paidPurchaseFromSession,
  verifyWebhookEvent,
};
