// Stub: no real payment processor is wired up yet. PayPal's client-side JS
// SDK still renders a real button and completes a real (sandbox) order
// approval in the browser -- this function is the one place that would
// call PayPal's Orders API to actually capture the payment server-side
// (which needs a Client Secret that isn't configured here). Swap this
// implementation for a real one once PayPal credentials are chosen; every
// caller already goes through this single function, so nothing else
// needs to change. Same pattern as emailDelivery.js.
async function captureOrder(orderId, { email, addressCount, priceCents }) {
  console.log(
    `[billing stub] would capture PayPal order ${orderId} for ${email}: ` +
      `${addressCount} addresses, $${(priceCents / 100).toFixed(2)}`
  );
  return { captured: false, stubbed: true, orderId };
}

module.exports = { captureOrder };
