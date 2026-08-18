const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

function isSesConfigured() {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.SES_FROM_EMAIL
  );
}

/** Shared plain-text send, used by both sendServiceKeyEmail and sendFeedbackNotification. */
async function sendPlainTextEmail({ to, subject, text }) {
  try {
    await new SESClient({ region: AWS_REGION }).send(
      new SendEmailCommand({
        Source: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject },
          Body: { Text: { Data: text } },
        },
      })
    );
    return { delivered: true, stubbed: false };
  } catch (err) {
    console.error(`[emailDelivery] failed to send "${subject}" to ${to}:`, err.message);
    return { delivered: false, stubbed: false, error: err.message };
  }
}

// sendResultsEmail is a deliberate stub -- no real email provider wired
// up for the batch-results ZIP attachment yet (that needs a raw MIME
// message, unlike the plain-text send above, so it's a separate,
// still-open piece of work). Swap this implementation once that's
// needed; every caller already goes through this single function, so
// nothing else needs to change.
async function sendResultsEmail(email, zipBuffer, meta = {}) {
  console.log(
    `[emailDelivery stub] would send ${zipBuffer.length}-byte ZIP to ${email}`,
    meta
  );
  return { delivered: false, stubbed: true };
}

/**
 * Emails a newly-issued/topped-up service key after a purchase, via AWS
 * SES -- falls back to a stub (logs and returns) when AWS_ACCESS_KEY_ID/
 * AWS_SECRET_ACCESS_KEY/SES_FROM_EMAIL aren't set, same pattern as
 * billing.js's captureOrder. The purchase itself has already succeeded
 * by the time this is called (money captured, quota already granted),
 * so a failure here is caught and reported back rather than thrown --
 * losing the email shouldn't undo a real purchase.
 */
async function sendServiceKeyEmail(email, { serviceKey, tier, purchased, priceCents }) {
  const text =
    `Thanks for your purchase!\n\n` +
    `Service key: ${serviceKey}\n\n` +
    `Present this key together with your account email (${email}) on every batch ` +
    `geocoding request -- there's no recovery flow if you lose it, so keep this email.\n\n` +
    `This purchase added ${purchased.toLocaleString()} addresses ($${(priceCents / 100).toFixed(2)}); ` +
    `your plan now covers ${tier.toLocaleString()} addresses per month.\n`;

  if (!isSesConfigured()) {
    console.log(`[emailDelivery stub] would email service key to ${email}`, { tier, purchased });
    return { delivered: false, stubbed: true };
  }

  return sendPlainTextEmail({ to: email, subject: 'Your geocoding service key', text });
}

/**
 * Emails a Road Alerts service key -- either just-issued or re-sent
 * (someone registering again with an email that already has an account,
 * see roadAlertsAccounts.js's registerAccount -- this is this feature's
 * only "forgot my key" recovery path). Same SES-vs-stub pattern as
 * sendServiceKeyEmail, but its own function rather than a reuse of that
 * one: the copy here is Road-Alerts-specific, not purchase/tier-specific.
 * Road Alerts is free for every registered account right now (no trial
 * clock, no charge) -- watching real usage before deciding on billing,
 * not building trial-abuse defenses against a monetization scheme that
 * doesn't exist yet. See docs/ROAD_ALERTS_DESIGN.md.
 */
async function sendRoadAlertsWelcomeEmail(email, { serviceKey, alreadyRegistered }) {
  const text =
    (alreadyRegistered ? `Welcome back to Road Alerts.\n\n` : `Welcome to Road Alerts.\n\n`) +
    `Service key: ${serviceKey}\n\n` +
    `Present this key together with your account email (${email}) every time the app checks ` +
    `for road alerts -- there's no separate recovery flow if you lose it, so keep this email ` +
    `(registering again with the same email re-sends this same key).\n\n` +
    `Road Alerts is free while we're testing it -- no payment required, and we'll email you ` +
    `before that ever changes.\n`;

  if (!isSesConfigured()) {
    console.log(`[emailDelivery stub] would email Road Alerts service key to ${email}`, {
      alreadyRegistered,
    });
    return { delivered: false, stubbed: true };
  }

  return sendPlainTextEmail({ to: email, subject: 'Your Road Alerts service key', text });
}

/**
 * Emails one road alert (a RoadSignal the client already has -- see
 * roadSignals.js) to the account's own registered email, on request --
 * the "save this / email it" voice command in RoadAlertsForm.tsx, or any
 * other on-demand save. Same SES-vs-stub pattern as the sends above.
 * Uses the signal's own `speech.deep` text (already the fullest human
 * -readable account of it, see roadSignals.js's buildSpeech) rather than
 * re-deriving a summary here.
 */
async function sendRoadAlertEmail(email, signal) {
  const text =
    `${signal.speech.deep}\n\n` +
    `Road: ${signal.roadway ?? 'unknown'}\n` +
    `Severity: ${signal.severity}\n` +
    (typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
      ? `Location: ${signal.latitude}, ${signal.longitude}\n`
      : '') +
    `Source: ${signal.source} (${signal.network})\n`;

  if (!isSesConfigured()) {
    console.log(`[emailDelivery stub] would email road alert ${signal.id} to ${email}`);
    return { delivered: false, stubbed: true };
  }

  return sendPlainTextEmail({
    to: email,
    subject: `Road alert saved: ${signal.roadway ?? 'traffic hazard'}`,
    text,
  });
}

/**
 * Emails an account's daily Road Alerts digest -- everything they saved
 * via the voice "save"/"keep"/"email" command since the last digest
 * (see roadAlertsSurfacedLog.js), for an opted-in account to review off
 * the road. `alerts` is a non-empty array of road_alerts_surfaced_log
 * rows; the caller (roadAlertsDigest.js) never calls this for an
 * account with nothing pending. Same SES-vs-stub pattern as the sends
 * above.
 */
async function sendRoadAlertsDigestEmail(email, alerts) {
  const text =
    `Alerts you saved in the last day:\n\n` +
    alerts
      .map((alert) => {
        const when = new Date(alert.surfaced_at).toLocaleString('en-US', { timeZone: 'UTC' });
        return (
          `- ${alert.roadway ?? 'Unknown road'} (${alert.severity})\n` +
          (alert.description ? `  ${alert.description}\n` : '') +
          `  Saved: ${when} UTC\n`
        );
      })
      .join('\n') +
    `\nThis digest only includes alerts you explicitly saved while driving -- not everything ` +
    `spoken aloud along the way.\n`;

  if (!isSesConfigured()) {
    console.log(`[emailDelivery stub] would email a Road Alerts digest (${alerts.length} alert(s)) to ${email}`);
    return { delivered: false, stubbed: true };
  }

  return sendPlainTextEmail({
    to: email,
    subject: `Your Road Alerts digest -- ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`,
    text,
  });
}

/**
 * Notifies the site owner (FEEDBACK_NOTIFY_EMAIL) that a comment/question
 * came in, via AWS SES -- falls back to a stub when SES isn't configured
 * or FEEDBACK_NOTIFY_EMAIL isn't set. The feedback row is already saved
 * in Postgres by the time this runs (see feedback.js's submitFeedback),
 * so a failed notification is reported back rather than thrown -- the
 * comment itself isn't lost, it's just not proactively flagged.
 */
async function sendFeedbackNotification({ name, email, message }) {
  const from = name || email || 'someone';
  const text =
    `New feedback from ${from}:\n\n` +
    `${message}\n\n` +
    (email ? `Reply directly to: ${email}\n` : `(no email left -- no way to reply)\n`);

  if (!isSesConfigured() || !process.env.FEEDBACK_NOTIFY_EMAIL) {
    console.log('[emailDelivery stub] would notify owner of new feedback', { name, email, message });
    return { delivered: false, stubbed: true };
  }

  return sendPlainTextEmail({
    to: process.env.FEEDBACK_NOTIFY_EMAIL,
    subject: 'New feedback on your geocoding site',
    text,
  });
}

module.exports = {
  sendResultsEmail,
  sendServiceKeyEmail,
  sendRoadAlertsWelcomeEmail,
  sendRoadAlertEmail,
  sendRoadAlertsDigestEmail,
  sendFeedbackNotification,
};
