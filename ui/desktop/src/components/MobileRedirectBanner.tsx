import { useState } from 'react';

import { isMobileDevice, isStandalone } from '../deviceDetection';

// Off entirely until VITE_MOBILE_APP_URL is actually set (e.g. in
// ui/desktop/.env.local, or the real deploy's env) -- no mobile
// deployment exists yet, so this has nothing to point at today. Once
// ui/mobile has its own real URL, set this and mobile visitors here
// get prompted toward it instead of the "install this as a PWA" banner
// (InstallAppBanner.tsx) -- showing both would be a contradictory
// pitch ("install this page" vs. "go use a different app"), so
// Layout.tsx renders at most one of the two.
export const MOBILE_APP_URL = import.meta.env.VITE_MOBILE_APP_URL as string | undefined;

const DISMISSED_KEY = 'meridian-mobile-redirect-dismissed';

export default function MobileRedirectBanner() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === '1');

  // Someone who already installed this page as a PWA has already made
  // their choice -- don't nag them to go somewhere else instead.
  if (!MOBILE_APP_URL || !isMobileDevice() || isStandalone() || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="install-banner">
      <span>Using a phone? Try our mobile app instead.</span>
      <a href={MOBILE_APP_URL}>Open</a>
      <button type="button" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
