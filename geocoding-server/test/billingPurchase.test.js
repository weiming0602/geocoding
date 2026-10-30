const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { upsertUser, getUser, recordUsage } = require('../src/users');
const { withTestServer, stubPurchase } = require('./helpers');

// A purchase is POST /billing/checkout-session (creates the Stripe Checkout
// Session) followed by POST /billing/complete (the browser back from
// Stripe) and/or Stripe's own webhook. withTestServer clears
// STRIPE_SECRET_KEY, so billing.js runs its stub -- these tests check what
// the routes do around it: validate the tier against server-side pricing
// (never trust a client-supplied price), top up the quota, and do so at
// most once per session. None of them touch the geocoding database.

const RETURN_URL = 'http://localhost:5173/#/checkout';

function post(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('a purchase tops up an existing user and returns the new quota', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const existing = await upsertUser(usersDb, 'alice@example.com', 5000);
      await recordUsage(usersDb, 'alice@example.com', 4800);

      const { session, response } = await stubPurchase(port, {
        email: 'alice@example.com',
        addressCount: 1000,
      });
      assert.equal(session.stubbed, true);
      assert.ok(session.url.startsWith(`${RETURN_URL}?session_id=${session.sessionId}`));

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.tier, 6000);
      assert.equal(body.usedThisPeriod, 4800);
      assert.equal(body.remaining, 1200);
      assert.equal(body.purchased, 1000);
      assert.equal(body.priceCents, 1500);
      assert.equal(body.stubbed, true);
      // Topping up an existing account must not invalidate its service key.
      assert.equal(body.serviceKey, existing.service_key);
      // withTestServer clears Resend env vars, so the email send is stubbed too.
      assert.equal(body.serviceKeyEmailed, false);

      assert.equal((await getUser(usersDb, 'alice@example.com')).tier, 6000);
    },
    { seedStreets: false }
  ));

test('a purchase creates a new user if none exists yet', () =>
  withTestServer(
    async ({ port }) => {
      const { response } = await stubPurchase(port, {
        email: 'newbie@example.com',
        addressCount: 500,
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.tier, 500);
      assert.equal(body.usedThisPeriod, 0);
      assert.match(body.serviceKey, /^mk_[0-9a-f]{48}$/);
    },
    { seedStreets: false }
  ));

test('completing the same session twice grants the quota only once', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const { session } = await stubPurchase(port, { email: 'alice@example.com', addressCount: 1000 });

      // e.g. a page refresh on the return URL, or the webhook having
      // already fulfilled it.
      const again = await post(port, '/billing/complete', { sessionId: session.sessionId });
      assert.equal(again.status, 200);
      const body = await again.json();
      assert.equal(body.tier, 1000);
      assert.match(body.serviceKey, /^mk_/);
      assert.equal(body.serviceKeyEmailed, null);

      assert.equal((await getUser(usersDb, 'alice@example.com')).tier, 1000);
      const { rows } = await usersDb.query('SELECT * FROM transactions');
      assert.equal(rows.length, 1);
    },
    { seedStreets: false }
  ));

test('concurrent completions of the same session grant the quota only once', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const session = await (
        await post(port, '/billing/checkout-session', {
          email: 'alice@example.com',
          addressCount: 2000,
          returnUrl: RETURN_URL,
        })
      ).json();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => post(port, '/billing/complete', { sessionId: session.sessionId }))
      );
      for (const response of responses) assert.equal(response.status, 200);

      assert.equal((await getUser(usersDb, 'alice@example.com')).tier, 2000);
      const { rows } = await usersDb.query('SELECT * FROM transactions');
      assert.equal(rows.length, 1);
    },
    { seedStreets: false }
  ));

test('POST /billing/checkout-session rejects an addressCount with no matching pricing tier', () =>
  withTestServer(
    async ({ port }) => {
      const response = await post(port, '/billing/checkout-session', {
        email: 'alice@example.com',
        addressCount: 999,
        returnUrl: RETURN_URL,
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /no pricing tier/);
    },
    { seedStreets: false }
  ));

test('POST /billing/checkout-session rejects a malformed email or returnUrl', () =>
  withTestServer(
    async ({ port }) => {
      const badEmail = await post(port, '/billing/checkout-session', {
        email: 'not-an-email',
        addressCount: 500,
        returnUrl: RETURN_URL,
      });
      assert.equal(badEmail.status, 400);

      for (const returnUrl of [undefined, '/#/checkout', 'javascript:alert(1)']) {
        const response = await post(port, '/billing/checkout-session', {
          email: 'alice@example.com',
          addressCount: 500,
          returnUrl,
        });
        assert.equal(response.status, 400, String(returnUrl));
        assert.match((await response.json()).error, /returnUrl/);
      }
    },
    { seedStreets: false }
  ));

test('a client-supplied price is ignored in favor of server-side pricing', () =>
  withTestServer(
    async ({ port }) => {
      // A client claiming addressCount:10000 is charged at the real $75
      // tier regardless of any priceCents it sends.
      const session = await (
        await post(port, '/billing/checkout-session', {
          email: 'alice@example.com',
          addressCount: 10000,
          priceCents: 1,
          returnUrl: RETURN_URL,
        })
      ).json();
      const response = await post(port, '/billing/complete', { sessionId: session.sessionId });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.priceCents, 7500);
      assert.equal(body.tier, 10000);
    },
    { seedStreets: false }
  ));

test('POST /billing/complete rejects a missing or made-up session id', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      assert.equal((await post(port, '/billing/complete', {})).status, 400);
      assert.equal((await post(port, '/billing/complete', { sessionId: 'cs_test_whatever' })).status, 400);
      const { rows } = await usersDb.query('SELECT * FROM users');
      assert.equal(rows.length, 0);
    },
    { seedStreets: false }
  ));

// The webhook route itself, with a real signature computed the way Stripe
// does (see billing.test.js for the signature checks in isolation).

function signedWebhook(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function completedSessionEvent(overrides = {}) {
  return JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_webhook1',
        payment_status: 'paid',
        currency: 'usd',
        amount_total: 1500,
        metadata: { email: 'alice@example.com', addressCount: '1000' },
        ...overrides,
      },
    },
  });
}

async function withWebhookSecret(fn) {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  try {
    await fn();
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
}

test('POST /billing/stripe-webhook 404s unless STRIPE_WEBHOOK_SECRET is set', () =>
  withTestServer(
    async ({ port }) => {
      const response = await post(port, '/billing/stripe-webhook', completedSessionEvent());
      assert.equal(response.status, 404);
    },
    { seedStreets: false }
  ));

test('POST /billing/stripe-webhook fulfills a paid session exactly once', () =>
  withTestServer(
    async ({ port, usersDb }) =>
      withWebhookSecret(async () => {
        const payload = completedSessionEvent();
        for (let i = 0; i < 2; i++) {
          // Stripe retries/redelivers -- the second delivery is a no-op.
          const response = await post(port, '/billing/stripe-webhook', payload, {
            'Stripe-Signature': signedWebhook(payload, 'whsec_test'),
          });
          assert.equal(response.status, 200);
        }

        assert.equal((await getUser(usersDb, 'alice@example.com')).tier, 1000);
        const { rows } = await usersDb.query('SELECT * FROM transactions');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].order_id, 'cs_test_webhook1');
      }),
    { seedStreets: false }
  ));

test('POST /billing/stripe-webhook rejects a bad signature without granting anything', () =>
  withTestServer(
    async ({ port, usersDb }) =>
      withWebhookSecret(async () => {
        const payload = completedSessionEvent();
        const response = await post(port, '/billing/stripe-webhook', payload, {
          'Stripe-Signature': signedWebhook(payload, 'whsec_wrong'),
        });
        assert.equal(response.status, 400);
        assert.equal(await getUser(usersDb, 'alice@example.com'), undefined);
      }),
    { seedStreets: false }
  ));

test('POST /billing/stripe-webhook acknowledges but ignores an unpaid or mismatched session', () =>
  withTestServer(
    async ({ port, usersDb }) =>
      withWebhookSecret(async () => {
        for (const payload of [
          completedSessionEvent({ payment_status: 'unpaid' }),
          completedSessionEvent({ amount_total: 1 }),
          completedSessionEvent({ metadata: {} }),
        ]) {
          const response = await post(port, '/billing/stripe-webhook', payload, {
            'Stripe-Signature': signedWebhook(payload, 'whsec_test'),
          });
          // 2xx so Stripe doesn't keep retrying something that will never succeed.
          assert.equal(response.status, 200);
        }
        assert.equal(await getUser(usersDb, 'alice@example.com'), undefined);
      }),
    { seedStreets: false }
  ));
