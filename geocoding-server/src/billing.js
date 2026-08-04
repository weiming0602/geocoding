const { PaymentError } = require('./errors');

// Falls back to a stub (logs and returns) whenever PAYPAL_CLIENT_ID/
// PAYPAL_CLIENT_SECRET aren't set -- same pattern as emailDelivery.js.
// Once both are set (a PayPal REST API app's credentials -- sandbox or
// live, controlled by PAYPAL_API_BASE), this calls PayPal's real Orders
// API to capture the payment server-side. That's deliberate: the client
// only *creates* the order and never calls `actions.order.capture()`
// itself (see Checkout.tsx/CheckoutSection.web.tsx) -- capturing
// server-side, with the secret, is what actually confirms the money
// moved rather than trusting the client's word for it.
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

function isConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await response.json();
  if (!response.ok) {
    throw new PaymentError(`PayPal authentication failed: ${body.error_description || response.status}`);
  }
  return body.access_token;
}

async function captureOrder(orderId, { email, addressCount, priceCents }) {
  if (!isConfigured()) {
    console.log(
      `[billing stub] would capture PayPal order ${orderId} for ${email}: ` +
        `${addressCount} addresses, $${(priceCents / 100).toFixed(2)}`
    );
    return { captured: false, stubbed: true, orderId };
  }

  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new PaymentError(
      `PayPal order capture failed: ${body.message || body.name || response.status}`
    );
  }
  if (body.status !== 'COMPLETED') {
    throw new PaymentError(`PayPal order was not completed (status: ${body.status})`);
  }

  // The order itself is created client-side (Checkout.tsx/
  // CheckoutSection.web.tsx), with no server-side link to a tier -- a
  // tampered client could create a PayPal order for any amount and then
  // claim any addressCount here. Comparing the *actual* captured amount
  // against the server-computed priceCents for that addressCount is
  // what actually stops that: a $0.01 order can only ever grant the
  // $0.01 tier, no matter what the request body claims.
  const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
  const capturedCents = capture && Math.round(Number(capture.amount.value) * 100);
  if (!capture || capture.amount.currency_code !== 'USD' || capturedCents !== priceCents) {
    throw new PaymentError(
      `captured amount doesn't match the ${addressCount}-address tier's price ` +
        `(expected $${(priceCents / 100).toFixed(2)} USD, got ` +
        `${capture ? `$${capture.amount.value} ${capture.amount.currency_code}` : 'no capture'})`
    );
  }

  return { captured: true, stubbed: false, orderId };
}

module.exports = { captureOrder };
