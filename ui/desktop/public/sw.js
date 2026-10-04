// Push-receive only -- no offline caching/precaching here (see
// docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md's
// scope: "no offline caching PWA behavior" is explicitly out of scope).
// Served verbatim from /sw.js by Vite, same as manifest.webmanifest,
// robots.txt, sitemap.xml -- no build step needed.

self.addEventListener('push', (event) => {
  let data = { title: 'Road Alert', body: '' };
  try {
    data = event.data.json();
  } catch {
    // Best-effort -- a malformed payload still shows a generic notification
    // rather than throwing and dropping the push entirely.
  }
  // icon/badge are ignored on iOS (which always uses the installed PWA's
  // own Home Screen icon for a push notification, full stop) but are
  // respected on Android/desktop Chrome -- harmless to include either way.
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    })
  );
});

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
