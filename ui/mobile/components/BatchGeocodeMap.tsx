import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export type MarkerPoint = {
  address: string;
  latitude: number;
  longitude: number;
  // Kept for type parity with BatchGeocodeMap.web.tsx (BatchGeocodeForm.tsx
  // is shared across both platforms) -- unused here, since there's no
  // interactive map on this platform to click or highlight anything on.
  resultIndex: number;
};

type Props = {
  markers: MarkerPoint[];
  selectedIndex?: number | null;
  focusRequest?: { index: number; nonce: number } | null;
  onMarkerClick?: (resultIndex: number) => void;
};

// Same limitation as GeocodeMap.tsx: no inline native map library is wired
// up yet (see that file's comment for why). Unlike a single address, there's
// no clean native equivalent of "open in Maps" for an arbitrary list of
// pins, so this just says so instead of guessing at one. selectedIndex/
// focusRequest/onMarkerClick (list<->map linking, see BatchGeocodeMap.web.tsx)
// have nothing to do here and are accepted but unused.
export default function BatchGeocodeMap({ markers }: Props) {
  if (markers.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        Map view isn't available on this platform yet — see the coordinates above.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  text: {
    color: '#666',
  },
});
