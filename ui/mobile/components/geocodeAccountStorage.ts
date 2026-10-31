import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { AccountCredentials } from '../../shared/api/client';

// The Geocode screen's optional account (email + service key), remembered
// between launches the same way roadAlertsStorage.ts remembers Road
// Alerts' -- the OS keychain natively, localStorage on web (see that file
// for why) -- under its own key, so signing in or out here never touches
// a Road Alerts sign-in.
const STORAGE_KEY = 'geocode_account';

export async function getStoredGeocodeAccount(): Promise<AccountCredentials | null> {
  try {
    const raw =
      Platform.OS === 'web' ? window.localStorage.getItem(STORAGE_KEY) : await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.email === 'string' && typeof parsed?.serviceKey === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Saves `account`, or forgets it when both fields are blank. Never throws -- a lookup still works unsaved. */
export async function setStoredGeocodeAccount(account: AccountCredentials): Promise<void> {
  const blank = !account.email.trim() && !account.serviceKey.trim();
  try {
    if (Platform.OS === 'web') {
      if (blank) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
    } else if (blank) {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    } else {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(account));
    }
  } catch {
    // Not remembered this time.
  }
}
