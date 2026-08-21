// Road Alerts is this app's first feature needing persistence across a
// visit -- every other service-key field (Batch, etc.) is retyped every
// time, fine for a one-off run but a bad fit for something you'd want
// signed in on every visit. ui/mobile has its own version of this
// backed by expo-secure-store/SecureStore; this is the plain-localStorage
// equivalent for a browser-only app -- see roadAlertsStorage.ts there for
// why the storage mechanism differs per platform.
const STORAGE_KEY = 'road_alerts_account';

export type StoredRoadAlertsAccount = { email: string; serviceKey: string };

export function getStoredAccount(): StoredRoadAlertsAccount | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredRoadAlertsAccount;
  } catch {
    return null;
  }
}

export function setStoredAccount(account: StoredRoadAlertsAccount): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
}

export function clearStoredAccount(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
