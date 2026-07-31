// Stub: no real email provider is wired up yet (deliberately deferred —
// see the batch-quota feature discussion). Swap this implementation for
// a real one (nodemailer+SMTP, SES, SendGrid, ...) once a provider is
// chosen; every caller already goes through this single function, so
// nothing else needs to change.
async function sendResultsEmail(email, zipBuffer, meta = {}) {
  console.log(
    `[emailDelivery stub] would send ${zipBuffer.length}-byte ZIP to ${email}`,
    meta
  );
  return { delivered: false, stubbed: true };
}

module.exports = { sendResultsEmail };
