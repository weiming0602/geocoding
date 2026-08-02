import type { Coordinates } from './api/types';

/** Parses "lat, lon" (or "lat lon") into { latitude, longitude }, or null if unparseable. */
export function parseCoordinateInput(input: string): Coordinates | null {
  const parts = input
    .trim()
    .split(/[,\s]+/)
    .filter(Boolean);
  if (parts.length !== 2) return null;

  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return { latitude, longitude };
}
