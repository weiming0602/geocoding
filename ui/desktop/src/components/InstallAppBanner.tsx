import { useEffect, useState } from 'react';

// Chrome/Android/Edge fire this before showing their own install UI; we
// capture it so we can trigger the same install flow from our own button
// instead of waiting for the browser's native mini-infobar. Not a
// standard DOM type, hence the manual shape here.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const DISMISSED_KEY = 'meridian-install-banner-dismissed';

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's own (non-standard) flag for "launched from a home
    // screen icon" -- matchMedia above doesn't cover it on iOS.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function InstallAppBanner() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === '1');
  const [standalone] = useState(isStandalone);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  if (standalone || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  // Safari never fires beforeinstallprompt (Apple hasn't implemented it),
  // so an iPhone/iPad visitor only ever gets manual instructions here --
  // there is no button that can trigger "Add to Home Screen" for them.
  if (isIos()) {
    return (
      <div className="install-banner">
        <span>
          Install Meridian: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
        </span>
        <button type="button" onClick={dismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
    );
  }

  if (!installEvent) return null;

  const install = async () => {
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  };

  return (
    <div className="install-banner">
      <span>Install Meridian as an app on this device.</span>
      <button type="button" onClick={install}>
        Install
      </button>
      <button type="button" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
