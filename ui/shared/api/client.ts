import type {
  ApiErrorResponse,
  BatchGeocodeResponse,
  BatchSource,
  Coordinates,
  GeocodeResult,
  PlaceSearchResponse,
  QuotaStatus,
  ReverseGeocodeResult,
  EmailRoadAlertResponse,
  RoadAlertsPreferencesResponse,
  RoadAlertsRegisterResponse,
  RoadAlertsUsernameResponse,
  RoadSignal,
  RoadSignalsResponse,
  TestWeightedPoint,
  TestWeightedPointsResponse,
} from './types';

// On a physical mobile device/simulator, "localhost" means the device
// itself, so ui/mobile callers need to pass their own baseUrl (e.g. your
// dev machine's LAN IP) instead of relying on this default. ui/desktop,
// running in a real browser on the same machine as the server (in dev),
// can use the default as-is.
export const DEFAULT_API_BASE_URL = 'http://localhost:3001';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const parsed = (await response.json()) as T | ApiErrorResponse;
  if (!response.ok || (parsed as ApiErrorResponse).error !== undefined) {
    throw new ApiError((parsed as ApiErrorResponse).error ?? `request failed (${response.status})`, response.status);
  }
  return parsed as T;
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const parsed = (await response.json()) as T | ApiErrorResponse;
  if (!response.ok || (parsed as ApiErrorResponse).error !== undefined) {
    throw new ApiError((parsed as ApiErrorResponse).error ?? `request failed (${response.status})`, response.status);
  }
  return parsed as T;
}

async function deleteJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
  const parsed = (await response.json()) as T | ApiErrorResponse;
  if (!response.ok || (parsed as ApiErrorResponse).error !== undefined) {
    throw new ApiError((parsed as ApiErrorResponse).error ?? `request failed (${response.status})`, response.status);
  }
  return parsed as T;
}

export function geocode(address: string, baseUrl = DEFAULT_API_BASE_URL): Promise<GeocodeResult> {
  return postJson<GeocodeResult>(baseUrl, '/geocode', { address });
}

export function reverseGeocode(
  coordinates: Coordinates,
  baseUrl = DEFAULT_API_BASE_URL
): Promise<ReverseGeocodeResult> {
  return postJson<ReverseGeocodeResult>(baseUrl, '/reverse-geocode', coordinates);
}

export function batchGeocode(
  source: BatchSource,
  baseUrl = DEFAULT_API_BASE_URL
): Promise<BatchGeocodeResponse> {
  return postJson<BatchGeocodeResponse>(baseUrl, '/geocode/batch', source);
}

/**
 * Returns the ZIP as a Blob -- caller decides how to save/download it
 * (platform-specific) -- plus the X-Quota header's "used/tier" text,
 * since a binary response body can't also carry JSON quota fields the
 * way batchGeocode()'s does.
 */
export async function batchGeocodeDownload(
  source: BatchSource,
  baseUrl = DEFAULT_API_BASE_URL
): Promise<{ blob: Blob; quota: string | null }> {
  const response = await fetch(`${baseUrl}/geocode/batch/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(source),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(body?.error ?? `download failed (${response.status})`, response.status);
  }
  return { blob: await response.blob(), quota: response.headers.get('X-Quota') };
}

export function getQuota(email: string, baseUrl = DEFAULT_API_BASE_URL): Promise<QuotaStatus> {
  return getJson<QuotaStatus>(baseUrl, `/quota?email=${encodeURIComponent(email)}`);
}

export function searchPlaces(
  // latitude/longitude are optional -- the server resolves them itself
  // when `query` includes a "near <place>" clause (see placesSearch.js's
  // parseNearQuery); required otherwise.
  params: { query: string; latitude?: number; longitude?: number; radiusMeters: number },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<PlaceSearchResponse> {
  return postJson<PlaceSearchResponse>(baseUrl, '/places/search', params);
}

export function getRoadSignals(
  params: { latitude: number; longitude: number; radiusMeters: number; email: string; serviceKey: string },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<RoadSignalsResponse> {
  const qs = new URLSearchParams({
    latitude: String(params.latitude),
    longitude: String(params.longitude),
    radiusMeters: String(params.radiusMeters),
    email: params.email,
    serviceKey: params.serviceKey,
  });
  return getJson<RoadSignalsResponse>(baseUrl, `/road-signals?${qs.toString()}`);
}

export function registerRoadAlerts(
  email: string,
  baseUrl = DEFAULT_API_BASE_URL
): Promise<RoadAlertsRegisterResponse> {
  return postJson<RoadAlertsRegisterResponse>(baseUrl, '/road-alerts/register', { email });
}

// Emails one road signal (already fetched from /road-signals) to the
// account's own registered email -- the "save this" voice command, or
// any other on-demand save. Always delivered to `params.email` itself;
// there's no separate recipient field.
export function emailRoadAlert(
  params: { email: string; serviceKey: string; signal: RoadSignal },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<EmailRoadAlertResponse> {
  return postJson<EmailRoadAlertResponse>(baseUrl, '/road-alerts/email-alert', params);
}

// The account's current opt-in flag for the daily email digest -- fetch
// on load (a stored account, from roadAlertsStorage.ts, carries no
// preference data of its own) and after registering/updating it.
export function getRoadAlertsPreferences(
  params: { email: string; serviceKey: string },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<RoadAlertsPreferencesResponse> {
  const qs = new URLSearchParams({ email: params.email, serviceKey: params.serviceKey });
  return getJson<RoadAlertsPreferencesResponse>(baseUrl, `/road-alerts/preferences?${qs.toString()}`);
}

export function updateRoadAlertsPreferences(
  params: { email: string; serviceKey: string; digestOptIn: boolean },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<RoadAlertsPreferencesResponse> {
  return postJson<RoadAlertsPreferencesResponse>(baseUrl, '/road-alerts/preferences', params);
}

// The account's current display name -- same fetch-fresh reasoning as
// preferences above (a stored account carries no profile data of its
// own). Null until the account has set one.
export function getRoadAlertsUsername(
  params: { email: string; serviceKey: string },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<RoadAlertsUsernameResponse> {
  const qs = new URLSearchParams({ email: params.email, serviceKey: params.serviceKey });
  return getJson<RoadAlertsUsernameResponse>(baseUrl, `/road-alerts/username?${qs.toString()}`);
}

export function updateRoadAlertsUsername(
  params: { email: string; serviceKey: string; username: string },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<RoadAlertsUsernameResponse> {
  return postJson<RoadAlertsUsernameResponse>(baseUrl, '/road-alerts/username', params);
}

// Test-only (see geocoding-server/src/testWeightedPoints.js) -- these
// three 404 unless the server has ALLOW_TEST_WEIGHTED_POINTS set, which
// is off by default. Never a real per-user routine store; just fake,
// developer-seeded points for exercising roadAlertsMatching.ts against
// live GPS and real 511 data.
export function addTestWeightedPoint(
  params: {
    email: string;
    serviceKey: string;
    latitude: number;
    longitude: number;
    weight: number;
    tlid?: string;
    label?: string;
  },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<TestWeightedPoint> {
  return postJson<TestWeightedPoint>(baseUrl, '/road-alerts/test/weighted-points', params);
}

export function getTestWeightedPoints(
  params: { email: string; serviceKey: string },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<TestWeightedPointsResponse> {
  const qs = new URLSearchParams({ email: params.email, serviceKey: params.serviceKey });
  return getJson<TestWeightedPointsResponse>(baseUrl, `/road-alerts/test/weighted-points?${qs.toString()}`);
}

export function clearTestWeightedPoints(
  params: { email: string; serviceKey: string },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<{ deleted: number }> {
  const qs = new URLSearchParams({ email: params.email, serviceKey: params.serviceKey });
  return deleteJson<{ deleted: number }>(baseUrl, `/road-alerts/test/weighted-points?${qs.toString()}`);
}
