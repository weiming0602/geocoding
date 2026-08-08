// Shared by InstallAppBanner, MobileRedirectBanner, and Layout (which
// needs to know in advance which of those two banners to even mount --
// showing both would be a contradictory pitch, "install this page" vs.
// "go use a different app instead").

export function isMobileDevice() {
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's own (non-standard) flag for "launched from a home
    // screen icon" -- matchMedia above doesn't cover it on iOS.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
