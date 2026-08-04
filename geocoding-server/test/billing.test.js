const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentError } = require('../src/errors');

// captureOrder() only exercises the real PayPal-calling path when both
// credentials are set -- withTestServer clears them for every other test
// file (see helpers.js) so route-level tests always hit the stub. These
// tests instead set them directly, mock global.fetch to stand in for
// PayPal's token + capture endpoints, and restore both afterward.

function withPaypalConfigured(fn) {
  return async () => {
    const savedClientId = process.env.PAYPAL_CLIENT_ID;
    const savedClientSecret = process.env.PAYPAL_CLIENT_SECRET;
    const savedFetch = global.fetch;
    process.env.PAYPAL_CLIENT_ID = 'test-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
    // A fresh require is unnecessary here -- unlike server.js, billing.js
    // reads process.env at call time (isConfigured()), not at require time.
    delete require.cache[require.resolve('../src/billing')];
    try {
      await fn(require('../src/billing').captureOrder);
    } finally {
      if (savedClientId !== undefined) process.env.PAYPAL_CLIENT_ID = savedClientId;
      else delete process.env.PAYPAL_CLIENT_ID;
      if (savedClientSecret !== undefined) process.env.PAYPAL_CLIENT_SECRET = savedClientSecret;
      else delete process.env.PAYPAL_CLIENT_SECRET;
      global.fetch = savedFetch;
      delete require.cache[require.resolve('../src/billing')];
    }
  };
}

function fakeFetch({ captureAmount, captureCurrency = 'USD', captureStatus = 'COMPLETED' }) {
  return async (url) => {
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, json: async () => ({ access_token: 'fake-token' }) };
    }
    if (String(url).includes('/capture')) {
      return {
        ok: true,
        json: async () => ({
          status: captureStatus,
          purchase_units: [
            {
              payments: {
                captures: [{ amount: { value: captureAmount, currency_code: captureCurrency } }],
              },
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

test(
  'captureOrder succeeds when the captured amount matches the tier price',
  withPaypalConfigured(async (captureOrder) => {
    global.fetch = fakeFetch({ captureAmount: '15.00' });
    const result = await captureOrder('ORDER-1', {
      email: 'alice@example.com',
      addressCount: 1000,
      priceCents: 1500,
    });
    assert.deepEqual(result, { captured: true, stubbed: false, orderId: 'ORDER-1' });
  })
);

test(
  'captureOrder rejects a captured amount lower than the tier price (the pay-a-penny bypass)',
  withPaypalConfigured(async (captureOrder) => {
    global.fetch = fakeFetch({ captureAmount: '0.01' });
    await assert.rejects(
      () =>
        captureOrder('ORDER-2', {
          email: 'alice@example.com',
          addressCount: 10000,
          priceCents: 7500,
        }),
      (err) => {
        assert.ok(err instanceof PaymentError);
        assert.match(err.message, /doesn't match/);
        return true;
      }
    );
  })
);

test(
  'captureOrder rejects a mismatched currency even if the numeric amount matches',
  withPaypalConfigured(async (captureOrder) => {
    global.fetch = fakeFetch({ captureAmount: '15.00', captureCurrency: 'EUR' });
    await assert.rejects(
      () =>
        captureOrder('ORDER-3', {
          email: 'alice@example.com',
          addressCount: 1000,
          priceCents: 1500,
        }),
      PaymentError
    );
  })
);

test(
  'captureOrder rejects a captured amount higher than the tier price',
  withPaypalConfigured(async (captureOrder) => {
    global.fetch = fakeFetch({ captureAmount: '999.00' });
    await assert.rejects(
      () =>
        captureOrder('ORDER-4', {
          email: 'alice@example.com',
          addressCount: 500,
          priceCents: 900,
        }),
      PaymentError
    );
  })
);
