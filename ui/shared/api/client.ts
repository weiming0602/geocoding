import type {
  ApiErrorResponse,
  BatchGeocodeResponse,
  BatchSource,
  Coordinates,
  GeocodeResult,
  QuotaStatus,
  ReverseGeocodeResult,
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
