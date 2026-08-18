import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Road Alerts is this app's first screen needing persistence at all --
// every other service-key field is retyped every visit (see
// BatchGeocodeForm.tsx), fine for a one-off batch run but a bad fit for
// something opened on every drive.
//
// expo-secure-store's web platform export is an empty object (confirmed
// by reading node_modules/expo-secure-store/src/ExpoSecureStore.web.ts --
// SDK 57 ships no web shim at all, not even a localStorage-backed one),
// so calling its functions on web throws a TypeError, not a graceful
// null. `localStorage` is the natural fallback there: a browser has no
// OS keychain either way, so this isn't a security downgrade specific to
// this app, and it's what lets "remembered account" behavior actually be
// verified in a browser-based preview, not only on a native simulator.
const STORAGE_KEY = 'road_alerts_account';

export type StoredRoadAlertsAccount = { email: string; serviceKey: string };

export async function getStoredAccount(): Promise<StoredRoadAlertsAccount | null> {
  const raw =
    Platform.OS === 'web' ? window.localStorage.getItem(STORAGE_KEY) : await SecureStore.getItemAsync(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredRoadAlertsAccount;
  } catch {
    return null;
  }
}

export async function setStoredAccount(account: StoredRoadAlertsAccount): Promise<void> {
  const raw = JSON.stringify(account);
  if (Platform.OS === 'web') {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } else {
    await SecureStore.setItemAsync(STORAGE_KEY, raw);
  }
}

export async function clearStoredAccount(): Promise<void> {
  if (Platform.OS === 'web') {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  }
}
