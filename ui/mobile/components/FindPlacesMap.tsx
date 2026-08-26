import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export type PlacePoint = {
  address: string;
  name: string;
  latitude: number;
  longitude: number;
  // Kept for type parity with FindPlacesMap.web.tsx (FindPlacesForm.tsx is
  // shared across both platforms) -- unused here, since there's no
  // interactive map on this platform to click or highlight anything on.
  resultIndex: number;
};

type Props = {
  center?: { latitude: number; longitude: number } | null;
  places: PlacePoint[];
  selectedIndex?: number | null;
  focusRequest?: { index: number; nonce: number } | null;
  onPlaceClick?: (resultIndex: number) => void;
};

// Same limitation as BatchGeocodeMap.tsx: no inline native map library is
// wired up yet (see GeocodeMap.tsx for why), and there's no clean native
// equivalent of "open in Maps" for a whole list of pins, so this just says
// so instead of guessing at one. center/selectedIndex/focusRequest/
// onPlaceClick (list<->map linking, see FindPlacesMap.web.tsx) have
// nothing to do here and are accepted but unused.
export default function FindPlacesMap({ places }: Props) {
  if (places.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        Map view isn't available on this platform yet — see the addresses above.
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
