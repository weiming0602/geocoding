import type { Coordinates, RerouteOption } from './api/types';

// Google's documented "Universal URL" for directions -- opens the Google
// Maps app if installed (iOS/Android, via its universal/app link) or
// Google Maps in a browser otherwise, with no API key: that's only
// needed for Directions/Places/Static Maps *API* calls, which this never
// makes. We're not asking Google to compute a route -- pgRouting
// (roadReroute.js) already did that -- just handing the result off so
// Google's own app can actually turn-by-turn navigate it, which this
// product deliberately doesn't try to do itself (see roadReroute.js's own
// "not a real routing engine" caveats: no live traffic, no one-way data).
const BASE_URL = 'https://www.google.com/maps/dir/';

// A full route can have hundreds of points; Google's own guidance for
// this URL form doesn't document a hard waypoint cap the way the paid
// Directions API's ~25 does, but a long query string is still both
// wasteful and more likely to get silently truncated by some client --
// this many, evenly spaced, is enough to bias the app toward the same
// corridor without either problem.
const MAX_WAYPOINTS = 8;

function coordString(point: Coordinates): string {
  return `${point.latitude},${point.longitude}`;
}

/**
 * Evenly samples up to `max` interior points from a route's coordinates
 * (GeoJSON [lon, lat] pairs) to use as waypoints -- excludes the first and
 * last points, since the caller supplies its own origin/destination
 * (the driver's actual position and the estimated rejoin point, not
 * pgRouting's graph-snapped path endpoints).
 */
export function sampleWaypoints(coordinates: [number, number][], max = MAX_WAYPOINTS): Coordinates[] {
  const interior = coordinates.slice(1, -1);
  if (interior.length <= max) {
    return interior.map(([longitude, latitude]) => ({ latitude, longitude }));
  }
  const step = interior.length / max;
  const sampled: Coordinates[] = [];
  for (let i = 0; i < max; i++) {
    const [longitude, latitude] = interior[Math.floor(i * step)];
    sampled.push({ latitude, longitude });
  }
  return sampled;
}

/**
 * Builds a Google Maps driving-directions URL for one reroute candidate --
 * origin/destination are the driver's real position and the estimated
 * rejoin point (not the route's own snapped endpoints), with a sampled
 * handful of the route's own points as waypoints so Google's app is
 * biased toward the same detour pgRouting found, not just any path
 * between the two.
 */
export function buildGoogleMapsDirectionsUrl(
  driverPosition: Coordinates,
  rejoinPoint: Coordinates,
  option: RerouteOption
): string {
  const params = new URLSearchParams({
    api: '1',
    origin: coordString(driverPosition),
    destination: coordString(rejoinPoint),
    travelmode: 'driving',
  });
  const waypoints = sampleWaypoints(option.geometry.coordinates);
  if (waypoints.length > 0) {
    params.set('waypoints', waypoints.map(coordString).join('|'));
  }
  return `${BASE_URL}?${params.toString()}`;
}
