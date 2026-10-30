import { Platform } from 'react-native';

// Stripe's hosted checkout page sends the web build back to
// `?checkout_tier=<addressCount>&session_id=...` (or `&canceled=1`) -- a
// fresh page load, and this app has no router, just in-memory screen
// state (see App.tsx). These read that return URL so App/PricingContent
// can start on the checkout screen it came from, and CheckoutSection.web
// can finish the purchase. Always null/empty on native, which has no
// Stripe checkout (see CheckoutSection.tsx).
function returnParams(): URLSearchParams {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function checkoutReturnTier(): number | null {
  const tier = Number(returnParams().get('checkout_tier'));
  return Number.isFinite(tier) && tier > 0 ? tier : null;
}

export function checkoutReturnSession(): { sessionId: string | null; canceled: boolean } {
  const params = returnParams();
  return { sessionId: params.get('session_id'), canceled: params.get('canceled') === '1' };
}

/** Builds the URL Stripe should send this page back to for `addressCount`. */
export function checkoutReturnUrl(addressCount: number): string {
  return `${window.location.origin}${window.location.pathname}?checkout_tier=${addressCount}`;
}

/** Drops the return parameters, so leaving checkout (or a refresh after) doesn't reopen it. */
export function clearCheckoutReturn(): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.search) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  }
}
