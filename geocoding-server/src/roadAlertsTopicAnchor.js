const { reverseGeocode } = require('./reverseGeocode');
const { NotFoundError } = require('./errors');

/**
 * Resolves a point to the tlid of its nearest street segment, for
 * anchoring a road-topic to a persistent location rather than to a
 * volatile 511 signal.id. Reuses reverseGeocode()'s own expanding-
 * radius nearest-segment search (findCandidates + closestPointOnLine)
 * rather than reimplementing it -- this only needs the tlid off the
 * match, not the interpolated house number reverseGeocode() also
 * computes.
 *
 * Runs against the read-only `db` pool (streets/`geocoding` database)
 * -- never usersDb. Returns null (not an error) when no street is
 * found nearby; road_alerts_topics.tlid is nullable specifically for
 * this case, see roadAlertsTopics.js.
 */
async function resolveTlid(db, latitude, longitude) {
  try {
    const result = await reverseGeocode(db, latitude, longitude);
    return result.match.tlid ?? null;
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

module.exports = { resolveTlid };
