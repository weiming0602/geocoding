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

/**
 * A short, distinct two-tone chime -- synthesized via the Web Audio API
 * rather than an external audio file, so there's no asset to load or
 * license. Meant to be noticed (and make someone glance over) before the
 * spoken alert itself is even understood. Best-effort: a failure here
 * (no AudioContext, a browser autoplay restriction, etc.) never throws,
 * since the chime is a bonus on top of speech, not a replacement for it.
 */
export function playAlertChime(): void {
  const Ctor = getAudioContextConstructor();
  if (!Ctor) return;
  try {
    const context = new Ctor();
    const now = context.currentTime;
    const tones = [
      { frequency: 660, start: 0 },
      { frequency: 880, start: 0.16 },
    ];
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
    // one once both tones have finished playing so repeated alerts don't
    // leak them.
    setTimeout(() => {
      context.close().catch(() => {});
    }, 400);
  } catch {
    // Best-effort -- see the module comment above.
  }
}

export function isNotificationAvailable(): boolean {
  return 'Notification' in window;
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
 * Shows a real OS-level notification if permission has already been
 * granted -- a no-op otherwise (including "default"/not-yet-asked; this
 * never itself prompts, see requestNotificationPermission). Clicking it
 * brings this tab back into focus and dismisses the notification.
 */
export function showAlertNotification(title: string, body: string): void {
  if (!isNotificationAvailable() || Notification.permission !== 'granted') return;
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
