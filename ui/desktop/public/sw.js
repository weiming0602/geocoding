// Push-receive only -- no offline caching/precaching here (see
// docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md's
// scope: "no offline caching PWA behavior" is explicitly out of scope).
// Served verbatim from /sw.js by Vite, same as manifest.webmanifest,
// robots.txt, sitemap.xml -- no build step needed.

// The notification picture (route trail, car, hazard) -- see
// alert-sketch.js. Optional: if it fails to load, notifications are
// simply text-only, as before.
try {
  importScripts('/alert-sketch.js');
} catch {
  // Best-effort -- see above.
}

/**
 * Shows a Road Alerts notification, with the sketch picture attached when
 * `sketch` coordinates are given and this browser can draw it
 * (OffscreenCanvas). Used by both the background push (the server sends
 * `sketch` in the payload -- see scripts/road-alerts-push-worker.js) and
 * in-tab alerts (the page posts a message -- see roadAlertNotifications.ts),
 * so both look the same. Platforms that ignore `image` (macOS, iOS,
 * Firefox) just show the text.
 */
async function showRoadAlert({ title, body, sketch }) {
  let image;
  if (sketch && self.RoadAlertSketch) {
    try {
      image = (await self.RoadAlertSketch.renderSketchDataUrl(sketch)) || undefined;
    } catch {
      // Best-effort -- fall back to text-only rather than lose the alert.
    }
  }
  // icon/badge are ignored on iOS (which always uses the installed PWA's
  // own Home Screen icon for a push notification, full stop) but are
  // respected on Android/desktop Chrome -- harmless to include either way.
  return self.registration.showNotification(title || 'Road Alert', {
    body: body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    ...(image ? { image } : {}),
  });
}

self.addEventListener('push', (event) => {
  let data = { title: 'Road Alert', body: '' };
  try {
    data = event.data.json();
  } catch {
    // Best-effort -- a malformed payload still shows a generic notification
    // rather than throwing and dropping the push entirely.
  }
  event.waitUntil(showRoadAlert(data));
});

// In-tab alerts: the open Road Alerts page asks the service worker to show
// the notification, so it gets the same picture as a background push. It
// replies on the message's port once shown, so the page can fall back to a
// plain notification if no reply comes (see roadAlertNotifications.ts).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'road-alert-notification') {
    const reply = event.ports && event.ports[0];
    event.waitUntil(
      showRoadAlert(event.data).then(
        () => reply && reply.postMessage({ shown: true }),
        () => reply && reply.postMessage({ shown: false })
      )
    );
  }
});

// Take over open tabs as soon as a new version installs, instead of
// waiting until every tab of the site has been closed -- otherwise an
// already-open Road Alerts tab keeps talking to the previous service
// worker (which may not handle the message above) after a deploy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath = '/road-alerts';
  // App.tsx uses HashRouter -- the real route lives in the URL fragment,
  // not the path. openWindow('/road-alerts') (the previous bug here) opens
  // a path the static host has no file for, which falls back to
  // index.html with an empty hash -- HashRouter then defaults to "/"
  // (Overview), not Road Alerts.
  const targetUrl = new URL(`/#${targetPath}`, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientsList) => {
      for (const client of clientsList) {
        if (!('focus' in client)) continue;
        await client.focus();
        // postMessage, not Client.navigate() -- Safari's service worker
        // (this app's main target, iOS) has no navigate() at all.
        // App.tsx's ServiceWorkerNavigation listens for this and routes
        // via React Router's own navigate(), which works everywhere.
        client.postMessage({ type: 'road-alerts-notification-click', path: targetPath });
        return;
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
