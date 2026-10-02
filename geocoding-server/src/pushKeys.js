// Web Push (see scripts/road-alerts-push-worker.js) needs all three of
// these to send anything -- unset = feature silently disabled, same
// "unset = disabled" convention as HERE_API_KEY (see CLAUDE.md). Read
// fresh on every call (not cached at module-load time) so tests can
// change process.env and re-require this module to see the change.
function isPushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY;
}

/** Call once at process startup (server.js and the push worker both need this) before sending any push. */
function configureWebPush(webPushModule) {
  if (!isPushConfigured()) return;
  webPushModule.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

module.exports = { isPushConfigured, getVapidPublicKey, configureWebPush };
