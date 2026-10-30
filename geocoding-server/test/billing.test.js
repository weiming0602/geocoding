const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { PaymentError, ValidationError } = require('../src/errors');
const { findTier } = require('../src/pricing');

// billing.js only exercises the real Stripe-calling path when
// STRIPE_SECRET_KEY is set -- withTestServer clears it for every other test
// file (see helpers.js) so route-level tests always hit the stub. These
// tests instead set it directly, mock global.fetch to stand in for
// Stripe's API, and restore both afterward.

function withStripeConfigured(fn) {
  return async () => {
    const savedKey = process.env.STRIPE_SECRET_KEY;
    const savedFetch = global.fetch;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    // billing.js reads process.env at call time, but a fresh require keeps
    // each test independent of whatever an earlier one left behind.
    delete require.cache[require.resolve('../src/billing')];
    try {
      await fn(require('../src/billing'));
    } finally {
      if (savedKey !== undefined) process.env.STRIPE_SECRET_KEY = savedKey;
      else delete process.env.STRIPE_SECRET_KEY;
      global.fetch = savedFetch;
      delete require.cache[require.resolve('../src/billing')];
    }
  };
}

function paidSession(overrides = {}) {
  return {
    id: 'cs_test_abc',
    payment_status: 'paid',
    currency: 'usd',
    amount_total: 1500,
    metadata: { email: 'alice@example.com', addressCount: '1000' },
    ...overrides,
  };
}

test(
  'createCheckoutSession sends the server-side tier price and metadata to Stripe',
  withStripeConfigured(async ({ createCheckoutSession }) => {
    let request;
    global.fetch = async (url, init) => {
      request = { url: String(url), init };
      return { ok: true, json: async () => ({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' }) };
    };

    const result = await createCheckoutSession({
      email: 'alice@example.com',
      tier: findTier(10000),
      returnUrl: 'https://www.example.com/#/checkout',
    });

    assert.deepEqual(result, {
      sessionId: 'cs_test_new',
      url: 'https://checkout.stripe.com/c/pay/cs_test_new',
      stubbed: false,
    });
    assert.equal(request.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(request.init.headers.Authorization, 'Bearer sk_test_fake');
    const params = new URLSearchParams(request.init.body);
    assert.equal(params.get('mode'), 'payment');
    assert.equal(params.get('line_items[0][price_data][unit_amount]'), '7500');
    assert.equal(params.get('line_items[0][price_data][currency]'), 'usd');
    assert.equal(params.get('metadata[addressCount]'), '10000');
    assert.equal(params.get('metadata[email]'), 'alice@example.com');
    assert.equal(
      params.get('success_url'),
      'https://www.example.com/#/checkout?session_id={CHECKOUT_SESSION_ID}'
    );
    assert.equal(params.get('cancel_url'), 'https://www.example.com/#/checkout?canceled=1');
  })
);

test(
  'createCheckoutSession surfaces a Stripe error as a PaymentError',
  withStripeConfigured(async ({ createCheckoutSession }) => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API Key provided' } }),
    });
    await assert.rejects(
      () =>
        createCheckoutSession({
          email: 'alice@example.com',
          tier: findTier(500),
          returnUrl: 'https://www.example.com/#/checkout',
        }),
      (err) => err instanceof PaymentError && /Invalid API Key/.test(err.message)
    );
  })
);

test(
  'retrievePaidPurchase returns the purchase for a paid session',
  withStripeConfigured(async ({ retrievePaidPurchase }) => {
    global.fetch = async (url) => {
      assert.equal(String(url), 'https://api.stripe.com/v1/checkout/sessions/cs_test_abc');
      return { ok: true, json: async () => paidSession() };
    };
    const purchase = await retrievePaidPurchase('cs_test_abc');
    assert.equal(purchase.email, 'alice@example.com');
    assert.equal(purchase.tier.addressCount, 1000);
    assert.equal(purchase.sessionId, 'cs_test_abc');
    assert.equal(purchase.stubbed, false);
  })
);

test(
  'retrievePaidPurchase rejects an unpaid session',
  withStripeConfigured(async ({ retrievePaidPurchase }) => {
    global.fetch = async () => ({ ok: true, json: async () => paidSession({ payment_status: 'unpaid' }) });
    await assert.rejects(() => retrievePaidPurchase('cs_test_abc'), PaymentError);

    // Checkout finished, money not yet in (a bank debit) -- says so plainly.
    global.fetch = async () => ({
      ok: true,
      json: async () => paidSession({ status: 'complete', payment_status: 'unpaid' }),
    });
    await assert.rejects(() => retrievePaidPurchase('cs_test_abc'), /still processing/);
  })
);

test(
  'retrievePaidPurchase rejects a stub session id once Stripe is configured',
  withStripeConfigured(async ({ retrievePaidPurchase }) => {
    global.fetch = async () => {
      throw new Error('should not reach Stripe');
    };
    await assert.rejects(() => retrievePaidPurchase('cs_stub_1000_YQ_00'), ValidationError);
    await assert.rejects(() => retrievePaidPurchase('../v1/charges'), ValidationError);
  })
);

test('paidPurchaseFromSession rejects an amount that does not match the tier price', () => {
  const { paidPurchaseFromSession } = require('../src/billing');
  assert.throws(() => paidPurchaseFromSession(paidSession({ amount_total: 1 })), PaymentError);
  assert.throws(() => paidPurchaseFromSession(paidSession({ currency: 'eur' })), PaymentError);
  assert.throws(() => paidPurchaseFromSession(paidSession({ metadata: { email: 'a@b.co', addressCount: '999' } })), PaymentError);
});

// Webhook signatures, Stripe's documented scheme.

function sign(payload, secret, timestamp) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

async function withWebhookSecret(fn) {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  try {
    await fn(require('../src/billing').verifyWebhookEvent);
  } finally {
    if (saved !== undefined) process.env.STRIPE_WEBHOOK_SECRET = saved;
    else delete process.env.STRIPE_WEBHOOK_SECRET;
  }
}

test('verifyWebhookEvent accepts a correctly signed event (among several v1 signatures)', () =>
  withWebhookSecret((verifyWebhookEvent) => {
    const payload = '{"type":"checkout.session.completed"}';
    const t = 1700000000;
    const header = `t=${t},v1=${sign(payload, 'whsec_old', t)},v1=${sign(payload, 'whsec_test', t)}`;
    const event = verifyWebhookEvent(Buffer.from(payload), header, { now: t * 1000 });
    assert.equal(event.type, 'checkout.session.completed');
  }));

test('verifyWebhookEvent rejects a tampered body, a wrong secret, a stale timestamp, or no header', () =>
  withWebhookSecret((verifyWebhookEvent) => {
    const payload = '{"type":"checkout.session.completed"}';
    const t = 1700000000;
    const good = `t=${t},v1=${sign(payload, 'whsec_test', t)}`;

    assert.throws(
      () => verifyWebhookEvent(Buffer.from(payload.replace('completed', 'expired')), good, { now: t * 1000 }),
      PaymentError
    );
    assert.throws(
      () => verifyWebhookEvent(Buffer.from(payload), `t=${t},v1=${sign(payload, 'whsec_nope', t)}`, { now: t * 1000 }),
      PaymentError
    );
    assert.throws(
      () => verifyWebhookEvent(Buffer.from(payload), good, { now: (t + 301) * 1000 }),
      /tolerance/
    );
    assert.throws(() => verifyWebhookEvent(Buffer.from(payload), undefined), PaymentError);
  }));
