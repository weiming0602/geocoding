import { registerRootComponent } from 'expo';

import App from './App';
import { setApiBaseUrl } from '../shared/api/client';

// Unset in dev (falls back to DEFAULT_API_BASE_URL's own localhost:3001);
// set EXPO_PUBLIC_API_BASE_URL to point at a deployed API's real origin.
const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
if (apiBaseUrl) setApiBaseUrl(apiBaseUrl);

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
