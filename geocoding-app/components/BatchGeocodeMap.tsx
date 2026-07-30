import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export type MarkerPoint = {
  address: string;
  latitude: number;
  longitude: number;
};

type Props = {
  markers: MarkerPoint[];
};

// Same limitation as GeocodeMap.tsx: no inline native map library is wired
// up yet (see that file's comment for why). Unlike a single address, there's
// no clean native equivalent of "open in Maps" for an arbitrary list of
// pins, so this just says so instead of guessing at one.
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
