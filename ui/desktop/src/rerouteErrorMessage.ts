import { ApiError } from '../../shared/api/client';

// Mirrors geocoding-server/src/roadReroute.js's MAX_HAZARD_DISTANCE_METERS
// (same dual-maintenance pattern as other server/client constant pairs in
// this repo) -- beyond this the server answers 422 instead of a detour.
export const REROUTE_MAX_DISTANCE_METERS = 5000;

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
  // roadReroute.js's two 404s: a point it couldn't snap to the street
  // network (usually the estimated "past the hazard" point landing in open
  // country -- it's a fixed distance along the driver's heading, not a
  // real road position), or no route existing at all.
  if (err instanceof ApiError && err.status === 404 && /no routable street data/.test(err.message)) {
    return (
      "Couldn't plan a detour here: the estimated point past this hazard isn't near a mapped street. " +
      'Try again in a moment from a little further along.'
    );
  }
  if (err instanceof ApiError && err.status === 404) {
    return 'No way around this hazard was found from where you are.';
  }
  return 'Could not find a detour right now -- try again.';
}
