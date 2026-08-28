// Dynamic (JS, not static app.json) so Android's Google Maps API key can
// come from an env var (GOOGLE_MAPS_API_KEY, e.g. via a gitignored
// .env.local -- same pattern as VITE_PAYPAL_CLIENT_ID/
// EXPO_PUBLIC_PAYPAL_CLIENT_ID elsewhere in this project) instead of being
// hardcoded. Unset is a supported, expected state (no Google Cloud project
// has been set up for this app yet) -- Android's map just won't render
// tiles without one; iOS is unaffected, since expo-maps' iOS side renders
// with Apple's own MapKit and needs no key at all.
module.exports = {
  expo: {
    name: 'geocoding-app',
    slug: 'geocoding-app',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    ios: {
      supportsTablet: true,
    },
    android: {
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      predictiveBackGestureEnabled: false,
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_API_KEY,
        },
      },
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-font',
      'expo-splash-screen',
      'expo-secure-store',
      [
        'expo-maps',
        {
          requestLocationPermission: true,
          locationPermission: 'Allow Meridian to use your location to show nearby road hazards on the map.',
        },
      ],
    ],
  },
};
