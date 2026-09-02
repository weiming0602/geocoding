import { useEffect, useState } from 'react';

import {
  getMapMarkerCap,
  getNavigatorConnection,
  type MapMarkerCap,
} from '../../shared/connectionCap';

// Re-evaluates the Batch geocode map's marker cap on mount, then live
// whenever the browser reports a connection change (Wi-Fi -> cellular,
// throttling, etc.) via the Network Information API's 'change' event --
// "automatically evaluate the connection ... on the fly" per the feature
// request, not just a one-time reading at load. A no-op subscription
// (cap just stays at the initial default) wherever that API isn't
// available -- see connectionCap.ts's own comment.
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
