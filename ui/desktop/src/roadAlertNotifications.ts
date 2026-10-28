// Stronger attention-grabbing delivery for a serious/need-to-know Road
// Alert, on top of the existing spoken alert -- plain speechSynthesis
// alone is easy to miss (muted, a background tab, not paying attention),
// and this is a safety-relevant feature. Two independent layers, each a
// no-op when unsupported/unavailable rather than throwing, same
// "gracefully degrade" convention as webSpeechRecognition.ts.

function getAudioContextConstructor(): typeof AudioContext | null {
  const g = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

// One alert = the two-tone chime rung this many times, then silence:
// enough to be noticed, not so many it becomes annoying while driving.
// Callers ring once per check however many hazards it raised (see
// RoadAlerts.tsx's fetchSignals), so this is also the most an alert ever
// rings.
export const CHIME_RINGS = 3;
// From the start of one ring to the start of the next.
const RING_INTERVAL_SECONDS = 0.55;
// How long all CHIME_RINGS rings take -- callers hold the spoken alert
// until then, so it isn't talked over.
export const CHIME_DURATION_MS = Math.round(((CHIME_RINGS - 1) * RING_INTERVAL_SECONDS + 0.32) * 1000);

/**
 * A short, distinct two-tone chime, rung CHIME_RINGS times --
 * synthesized via the Web Audio API rather than an external audio file,
 * so there's no asset to load or license. Meant to be noticed (and make
 * someone glance over) before the spoken alert itself is even
 * understood. Best-effort: a failure here (no AudioContext, a browser
 * autoplay restriction, etc.) never throws, since the chime is a bonus on
 * top of speech, not a replacement for it.
 */
export function playAlertChime(): void {
  const Ctor = getAudioContextConstructor();
  if (!Ctor) return;
  try {
    const context = new Ctor();
    const now = context.currentTime;
    const tones = Array.from({ length: CHIME_RINGS }, (_, ring) => [
      { frequency: 660, start: ring * RING_INTERVAL_SECONDS },
      { frequency: 880, start: ring * RING_INTERVAL_SECONDS + 0.16 },
    ]).flat();
    for (const { frequency, start } of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      // Ramped, not a hard on/off -- an abrupt gain change on a live
      // oscillator produces an audible click/pop.
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.2, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.15);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now + start);
      oscillator.stop(now + start + 0.16);
    }
    // Browsers cap how many AudioContexts can exist at once -- close this
    // one once every ring has finished playing so repeated alerts don't
    // leak them.
    setTimeout(() => {
      context.close().catch(() => {});
    }, (CHIME_RINGS - 1) * RING_INTERVAL_SECONDS * 1000 + 400);
  } catch {
    // Best-effort -- see the module comment above.
  }
}

export function isNotificationAvailable(): boolean {
  return 'Notification' in window;
}

/**
 * Push requires a service worker plus the PushManager API -- false on
 * iOS Safari unless the page is currently running in installed (Home
 * Screen) mode, which is exactly the gate wanted here: no point asking
 * for a push subscription from a regular browser tab, since it will
 * simply fail. See docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
 */
export function isPushCapable(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  // A plain `new Uint8Array(length)` (rather than `Uint8Array.from`) is
  // backed by a concrete ArrayBuffer, not the wider ArrayBufferLike (which
  // also covers SharedArrayBuffer) TS infers for `.from` -- PushManager's
  // `applicationServerKey` type requires the former.
  const bytes = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    bytes[i] = rawData.charCodeAt(i);
  }
  return bytes;
}

/**
 * Subscribes this browser to Web Push, returning the subscription object
 * ready to POST to /road-signals/push-subscribe -- null if unsupported
 * or the subscribe call itself fails (e.g. permission not granted),
 * never throws, same graceful-degrade convention as the rest of this file.
 */
export async function subscribeToPush(publicKey: string): Promise<PushSubscriptionJSON | null> {
  if (!isPushCapable()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    return subscription.toJSON();
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget -- only actually prompts the browser's permission
 * dialog the first time (Notification.permission === 'default'); a
 * previous grant or denial is left alone, never re-asked. Meant to be
 * called once, when the driver presses Start, not lazily the first time
 * an alert would want to show one -- prompting mid-alert would be a
 * jarring first ask.
 */
export function requestNotificationPermission(): void {
  if (!isNotificationAvailable()) return;
  if (Notification.permission !== 'default') return;
  Notification.requestPermission().catch(() => {
    // Best-effort -- see the module comment above.
  });
}

/**
 * What the notification picture shows (see public/alert-sketch.js): the
 * driver's recent trail (oldest first), current position and heading
 * (degrees clockwise from north, or null if unknown), and the hazard.
 */
export type AlertSketchInput = {
  trail: { latitude: number; longitude: number }[];
  position: { latitude: number; longitude: number };
  headingDeg: number | null;
  hazard: { latitude: number; longitude: number };
};

// Drawing the sketch and showing the notification takes the service
// worker well under this; past it, assume it isn't going to happen.
const SERVICE_WORKER_REPLY_TIMEOUT_MS = 1500;

function showPageNotification(title: string, body: string): void {
  try {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Best-effort -- see the module comment above.
  }
}

/**
 * Shows a real OS-level notification if permission has already been
 * granted -- a no-op otherwise (including "default"/not-yet-asked; this
 * never itself prompts, see requestNotificationPermission).
 *
 * Goes through the service worker when one is registered (public/sw.js's
 * 'road-alert-notification' message), so the notification gets the same
 * route-sketch picture as a background push and the same click handling
 * (focus this tab, open Road Alerts). Without a service worker it falls
 * back to a plain text Notification from the page itself.
 */
export function showAlertNotification(title: string, body: string, sketch?: AlertSketchInput): void {
  if (!isNotificationAvailable() || Notification.permission !== 'granted') return;
  if (!('serviceWorker' in navigator)) {
    showPageNotification(title, body);
    return;
  }
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => {
      const worker = registration?.active;
      if (!worker) {
        showPageNotification(title, body);
        return;
      }
      // The service worker confirms on this channel once it has shown the
      // notification. No confirmation in time (e.g. an older service
      // worker version that doesn't handle this message) means it wasn't
      // shown -- never drop an alert silently, show a plain one instead.
      const channel = new MessageChannel();
      let settled = false;
      const fallback = setTimeout(() => {
        if (settled) return;
        settled = true;
        showPageNotification(title, body);
      }, SERVICE_WORKER_REPLY_TIMEOUT_MS);
      channel.port1.onmessage = (event: MessageEvent<{ shown?: boolean }>) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        if (!event.data?.shown) showPageNotification(title, body);
      };
      worker.postMessage({ type: 'road-alert-notification', title, body, sketch }, [channel.port2]);
    })
    .catch(() => showPageNotification(title, body));
}
