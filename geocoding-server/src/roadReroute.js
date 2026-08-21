const { ValidationError, UpstreamError } = require('./errors');
const { validateCoordinate, flatDistanceMeters } = require('./nextCrossStreet');
const { metersPerDegree } = require('./interpolate');

// Free-tier OpenRouteService -- the only free routing service found with
// real "avoid this area" support (OSRM's public demo can only offer
// alternative paths and hope one clears the hazard, no guarantee on a
// road with no real alternative). Unlike Overpass/Nominatim, ORS has no
// anonymous tier -- a personal API key is required, so this feature is
// unavailable (a clear "not configured" error, not a silent no-op) until
// one is set. Read live inside isOrsConfigured/getRoadReroute, not
// captured once at module load -- same reasoning as emailDelivery.js's
// isSesConfigured(), so a test (or a real env change) can toggle this
// without re-requiring the module.
function isOrsConfigured() {
  return Boolean(process.env.ORS_API_KEY);
}
const ORS_TIMEOUT_MS = 10000;

// 511 gives only a single point per hazard, never a real start/end span
// (see roadSignals.js) -- this is a deliberate approximation of "past
// it": far enough along the road to clear a typical incident, not so far
// it's a meaningfully different trip. Reflected back in the response's
// rejoinPoint so callers can tell the driver it's an estimate, not exact
// hazard-end data.
const REJOIN_DISTANCE_METERS = 1500;
// Radius of the avoid-area drawn around the hazard's own point -- wide
// enough to cover the incident itself plus queued traffic, not so wide
// it rules out a legitimately close parallel road.
const AVOID_RADIUS_METERS = 150;
// Beyond this, a "detour" isn't a real answer to a hazard this far
// away yet -- same reasoning/threshold family as nextCrossStreet.js's
// own distance guard.
const MAX_HAZARD_DISTANCE_METERS = 5000;

/**
 * Bearing from (lat1,lon1) to (lat2,lon2), in degrees [0, 360) clockwise
 * from north -- flat-plane approximation via metersPerDegree, same
 * approach as nextCrossStreet.js's flatDistanceMeters, not a separate
 * spherical trig implementation.
 */
function bearingDegreesFlat(lat1, lon1, lat2, lon2) {
  const [mPerDegLon, mPerDegLat] = metersPerDegree((lat1 + lat2) / 2);
  const dx = (lon2 - lon1) * mPerDegLon;
  const dy = (lat2 - lat1) * mPerDegLat;
  const degrees = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Destination point `distanceMeters` from (lat,lon) along `bearingDeg` -- flat-plane, inverse of bearingDegreesFlat. */
function destinationPointFlat(lat, lon, bearingDeg, distanceMeters) {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const dx = distanceMeters * Math.sin(bearingRad);
  const dy = distanceMeters * Math.cos(bearingRad);
  const [mPerDegLon, mPerDegLat] = metersPerDegree(lat);
  return { latitude: lat + dy / mPerDegLat, longitude: lon + dx / mPerDegLon };
}

/**
 * Rough circular GeoJSON polygon ring around (lat,lon) -- same flat-earth
 * degrees approximation (not a true geodesic circle) as placesSearch.js's
 * metersToViewbox / roadSignals.js's boundingBoxDegrees, good enough for
 * a ~150m avoid-area.
 */
function circlePolygon(latitude, longitude, radiusMeters, points = 16) {
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.cos((latitude * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= points; i += 1) {
    const angle = (i / points) * 2 * Math.PI;
    ring.push([longitude + lonDelta * Math.cos(angle), latitude + latDelta * Math.sin(angle)]);
  }
  return ring;
}

/**
 * Calls OpenRouteService for 1-2 alternate driving routes from the
 * driver's position to an estimated point past the hazard, avoiding a
 * buffer around the hazard itself. Throws ValidationError if rerouting
 * isn't configured (no ORS_API_KEY), OutOfRangeError-style distance
 * guard via a plain ValidationError (kept simple -- unlike
 * nextCrossStreet.js this isn't a search-radius concern, just a sanity
 * bound), UpstreamError for anything that's ORS's fault.
 */
async function getRoadReroute({ driverLatitude, driverLongitude, driverHeading, hazardLatitude, hazardLongitude }) {
  validateCoordinate(driverLatitude, driverLongitude, 'driver');
  validateCoordinate(hazardLatitude, hazardLongitude, 'hazard');

  if (!isOrsConfigured()) {
    throw new ValidationError('rerouting is not configured on this server yet (missing ORS_API_KEY)');
  }

  const directDistance = flatDistanceMeters(driverLatitude, driverLongitude, hazardLatitude, hazardLongitude);
  if (directDistance > MAX_HAZARD_DISTANCE_METERS) {
    throw new ValidationError(
      `hazard is ${Math.round(directDistance)}m away, beyond the ${MAX_HAZARD_DISTANCE_METERS}m range this feature covers`
    );
  }

  // Continue along the driver's own heading if known (the road's actual
  // direction of travel); otherwise assume the road keeps going the same
  // way it has been from the driver to the hazard.
  const bearing =
    typeof driverHeading === 'number' && !Number.isNaN(driverHeading) && driverHeading >= 0
      ? driverHeading
      : bearingDegreesFlat(driverLatitude, driverLongitude, hazardLatitude, hazardLongitude);
  const rejoinPoint = destinationPointFlat(hazardLatitude, hazardLongitude, bearing, REJOIN_DISTANCE_METERS);

  const avoidRing = circlePolygon(hazardLatitude, hazardLongitude, AVOID_RADIUS_METERS);

  const orsBaseUrl = process.env.ORS_BASE_URL || 'https://api.openrouteservice.org';
  let response;
  try {
    response = await fetch(`${orsBaseUrl}/v2/directions/driving-car/geojson`, {
      method: 'POST',
      headers: {
        // ORS takes the raw key directly in this header, not a "Bearer"
        // scheme -- see https://openrouteservice.org/dev/#/api-docs.
        Authorization: process.env.ORS_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Meridian-Geocoding-Server/1.0 (+https://github.com/meridian-geocoding)',
      },
      body: JSON.stringify({
        coordinates: [
          [driverLongitude, driverLatitude],
          [rejoinPoint.longitude, rejoinPoint.latitude],
        ],
        alternative_routes: { target_count: 2 },
        options: { avoid_polygons: { type: 'Polygon', coordinates: [avoidRing] } },
      }),
      signal: AbortSignal.timeout(ORS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(`rerouting is temporarily unavailable: ${err.message}`);
  }

  if (!response.ok) {
    throw new UpstreamError(`rerouting is temporarily unavailable (status ${response.status})`);
  }

  const body = await response.json();
  const features = Array.isArray(body.features) ? body.features : [];
  const options = features.map((feature) => ({
    geometry: feature.geometry,
    distanceMeters: feature.properties?.summary?.distance ?? null,
    durationSeconds: feature.properties?.summary?.duration ?? null,
  }));

  return { options, rejoinPoint };
}

module.exports = {
  getRoadReroute,
  isOrsConfigured,
  circlePolygon,
  REJOIN_DISTANCE_METERS,
  AVOID_RADIUS_METERS,
  MAX_HAZARD_DISTANCE_METERS,
};
