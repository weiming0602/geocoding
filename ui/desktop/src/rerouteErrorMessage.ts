import { ApiError } from '../../shared/api/client';

// Mirrors geocoding-server/src/roadReroute.js's MAX_HAZARD_DISTANCE_METERS
// (same dual-maintenance pattern as other server/client constant pairs in
// this repo) -- beyond this the server answers 422 instead of a detour.
export const REROUTE_MAX_DISTANCE_METERS = 10000;

/**
 * What to tell the driver when "Show a way around this" fails, instead of
 * one generic line for every cause -- the server's 422 (hazard too far
 * away) and 404 (no route) mean very different things, and the first one
 * is fixed simply by trying again closer.
 */
export function rerouteErrorMessage(err: unknown, hazardDistanceMeters: number | null): string {
  if (err instanceof ApiError && err.status === 422) {
    const away = hazardDistanceMeters !== null ? `${(hazardDistanceMeters / 1000).toFixed(1)} km` : 'too far';
    return (
      `This hazard is ${away} away -- detours are offered once you're within ` +
      `${REROUTE_MAX_DISTANCE_METERS / 1000} km of it. Try again as you get closer.`
    );
  }
  // roadReroute.js's 404s: no mapped street past the hazard in the
  // direction of travel to rejoin, the driver not near a mapped street,
  // or no route existing at all.
  if (err instanceof ApiError && err.status === 404 && /past this hazard/.test(err.message)) {
    return "Couldn't plan a detour here: there's no mapped street past this hazard in your direction of travel to rejoin.";
  }
  if (err instanceof ApiError && err.status === 404 && /no routable street data/.test(err.message)) {
    return "Couldn't plan a detour here: you don't seem to be near a mapped street right now. Try again in a moment.";
  }
  if (err instanceof ApiError && err.status === 404) {
    return 'No way around this hazard was found from where you are.';
  }
  return 'Could not find a detour right now -- try again.';
}
