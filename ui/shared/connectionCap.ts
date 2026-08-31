// Chooses how many Batch geocode results get drawn on the map, based on the
// viewer's current network connection -- a slow/limited connection means
// fewer WebGL point features to ship/paint, a fast one can afford more. This
// is purely a map-rendering performance guard: it never affects the results
// table/list or any CSV/ZIP export, which stay complete and uncapped (see
// BatchMapView.tsx/BatchGeocodeMap.web.tsx callers).

export type MapMarkerCap = 250 | 500 | 750;

// Used whenever the Network Information API is unavailable at all (Safari,
// Firefox, and React Native's minimal `navigator` shim, which has no
// `.connection`) -- a sensible middle value rather than guessing high or low.
export const DEFAULT_MAP_MARKER_CAP: MapMarkerCap = 500;

export type ConnectionInfo = {
  // '4g' | '3g' | '2g' | 'slow-2g', per the Network Information API spec.
  effectiveType?: string;
  // Estimated downlink bandwidth in Mbps.
  downlink?: number;
};

// Pure mapping from a connection snapshot to a marker cap -- no `navigator`
// access here, so this is unit-testable without mocking the browser API.
// effectiveType is trusted first (it's the browser's own bucketed judgment
// call, informed by more signals than we have access to); downlink is used
// as a tiebreaker within '4g' and as the sole signal when effectiveType is
// missing/unrecognized.
export function capFromConnectionInfo(info: ConnectionInfo | undefined | null): MapMarkerCap {
  if (!info) return DEFAULT_MAP_MARKER_CAP;
  const { effectiveType, downlink } = info;

  if (effectiveType === 'slow-2g' || effectiveType === '2g') return 250;
  if (effectiveType === '3g') return 500;
  if (effectiveType === '4g') {
    return typeof downlink === 'number' && downlink < 5 ? 500 : 750;
  }
  if (typeof downlink === 'number') {
    if (downlink < 1.5) return 250;
    if (downlink < 5) return 500;
    return 750;
  }
  return DEFAULT_MAP_MARKER_CAP;
}

export type NavigatorConnection = ConnectionInfo & {
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
};

// The Network Information API is Chromium-only (Chrome/Edge/Android
// WebView) -- `navigator.connection`, with `mozConnection`/`webkitConnection`
// as fallbacks some older Chromium/Firefox-OS builds used. Entirely
// `undefined` on Safari/Firefox, and in React Native's `navigator` shim
// (no `.connection` property at all there) -- callers fall back to
// DEFAULT_MAP_MARKER_CAP in both cases, which also covers ui/mobile since
// no network-info package (e.g. expo-network, @react-native-community/netinfo)
// is currently installed there (see ui/mobile/package.json) and this is a
// minor-enough feature not to justify adding a new native dependency for it.
export function getNavigatorConnection(): NavigatorConnection | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as unknown as {
    connection?: NavigatorConnection;
    mozConnection?: NavigatorConnection;
    webkitConnection?: NavigatorConnection;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

export function getMapMarkerCap(): MapMarkerCap {
  return capFromConnectionInfo(getNavigatorConnection());
}
