import { useEffect, useState } from 'react';

import { getMapMarkerCap, getNavigatorConnection, type MapMarkerCap } from '../../shared/connectionCap';

// Same idea as ui/desktop/src/useMapMarkerCap.ts: re-evaluates the Batch
// geocode map's marker cap on mount, then live on a Network Information
// API 'change' event where that's available. On the web build (Platform.OS
// === 'web', react-native-web running in an actual browser) that's the same
// Chromium-only API desktop uses; on native, React Native's `navigator` shim
// has no `.connection` at all, so this just stays at
// DEFAULT_MAP_MARKER_CAP -- a fixed fallback rather than pulling in a new
// native module (e.g. expo-network, @react-native-community/netinfo) for
// this alone, since neither is currently installed (see package.json).
export function useMapMarkerCap(): MapMarkerCap {
  const [cap, setCap] = useState<MapMarkerCap>(getMapMarkerCap);

  useEffect(() => {
    const connection = getNavigatorConnection();
    if (!connection?.addEventListener) return;
    const handleChange = () => setCap(getMapMarkerCap());
    connection.addEventListener('change', handleChange);
    return () => connection.removeEventListener?.('change', handleChange);
  }, []);

  return cap;
}
