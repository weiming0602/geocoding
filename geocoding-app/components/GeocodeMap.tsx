import React from 'react';
import { Button, Linking, Platform, View } from 'react-native';

type Props = {
  latitude: number;
  longitude: number;
};

// Inline maps need expo-maps (iOS/Android only, alpha, needs a Google Maps
// API key on Android) or @maplibre/maplibre-react-native (needs a custom
// dev client, not plain Expo Go) - neither of which this project has set
// up yet. Until then, native platforms open the coordinates in the
// device's own Maps app instead of rendering an inline map.
export default function GeocodeMap({ latitude, longitude }: Props) {
  const handleOpenMaps = () => {
    const url = Platform.select({
      ios: `maps:0,0?q=${latitude},${longitude}`,
      android: `geo:${latitude},${longitude}?q=${latitude},${longitude}`,
      default: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=15/${latitude}/${longitude}`,
    });

    Linking.openURL(url).catch(() => {
      Linking.openURL(
        `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=15/${latitude}/${longitude}`
      );
    });
  };

  return (
    <View style={{ marginTop: 12 }}>
      <Button title="Open in Maps" onPress={handleOpenMaps} />
    </View>
  );
}
