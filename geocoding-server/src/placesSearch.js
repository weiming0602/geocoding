const { ValidationError, UpstreamError } = require('./errors');

// Public Overpass instance -- free, no API key, no billing account,
// consistent with how every other data source in this project is
// sourced (see DATA_SOURCES.md). It's shared and rate-limited (2
// concurrent request slots per IP as of writing -- check
// https://overpass-api.de/api/status), and regex tag queries are
// noticeably more expensive than exact-match ones; both are why the
// query below is kept to two clauses, not one per tag per word.
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_SECONDS = 25;
const MAX_RESULTS = 200;
const MAX_RADIUS_METERS = 25000;

/**
 * Splits a free-text query into individual words for tag matching --
 * Overpass has no free-text/semantic search, only tag equality/regex, so
 * "asian restaurant" becomes two independent word-level checks rather
 * than one exact phrase. This trades precision for recall: it'll catch
 * a "Thai Restaurant" or a "China Wok" that doesn't literally contain
 * the word "asian", at the cost of occasionally matching something only
 * loosely related.
 */
function queryWords(query) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[[\]{}()\\.*+?^$|]/g, '\\$&')); // escape regex metacharacters
}

/**
 * Two clauses per word, not four -- one against `name` (catches a
 * business's own name, e.g. "Tony's Pizzeria"), one against
 * cuisine/amenity/shop together via Overpass's generic any-key regex
 * syntax. Four separate per-tag regex clauses measurably risked timing
 * out the public instance during testing; this halves that cost.
 */
function buildOverpassQuery(words, latitude, longitude, radiusMeters) {
  const around = `(around:${radiusMeters},${latitude},${longitude})`;
  const clauses = [];
  for (const word of words) {
    clauses.push(`  node${around}["name"~"${word}",i];`);
    clauses.push(`  node${around}[~"^(cuisine|amenity|shop)$"~"${word}",i];`);
  }
  return `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}];\n(\n${clauses.join('\n')}\n);\nout body;`;
}

/**
 * Builds a Meridian-format address line ("123 Main St, Portland, ME
 * 04101") from an Overpass node's tags, or null if there isn't enough
 * to form one -- parseAddress.js requires a leading house number and a
 * 5-digit ZIP, so a node missing addr:housenumber, addr:street, or
 * addr:postcode can't produce a geocodable line no matter what else it
 * has (a name and a coordinate alone aren't enough).
 */
function addressLineFromTags(tags) {
  const houseNumber = tags['addr:housenumber'];
  const street = tags['addr:street'];
  const postcode = tags['addr:postcode'];
  if (!houseNumber || !street || !postcode) return null;

  const city = tags['addr:city'];
  const state = tags['addr:state'];
  const cityState = [city, state].filter(Boolean).join(', ');
  const middle = cityState ? `, ${cityState}` : '';
  return `${houseNumber} ${street}${middle} ${postcode}`.replace(/\s+/g, ' ').trim();
}

/**
 * Searches Overpass for places near (latitude, longitude) matching
 * `query`, extracting a Meridian-geocodable address line from each
 * result that has one. Results with a name/coordinate but no usable
 * street address are counted in `skipped`, not silently dropped.
 * Throws UpstreamError (not a generic Error) for anything that's
 * Overpass's fault -- a timeout, a rate limit, a non-2xx response --
 * so callers can tell "the free public service is having a moment"
 * apart from a real bug.
 */
async function searchPlaces(query, latitude, longitude, radiusMeters) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ValidationError('query must be a non-empty string');
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new ValidationError('latitude and longitude must be numbers');
  }
  if (typeof radiusMeters !== 'number' || radiusMeters <= 0) {
    throw new ValidationError('radiusMeters must be a positive number');
  }
  if (radiusMeters > MAX_RADIUS_METERS) {
    throw new ValidationError(`radiusMeters must be at most ${MAX_RADIUS_METERS}`);
  }

  const words = queryWords(query);
  if (words.length === 0) {
    throw new ValidationError('query must contain at least one word');
  }

  const overpassQuery = buildOverpassQuery(words, latitude, longitude, radiusMeters);

  let response;
  try {
    response = await fetch(OVERPASS_URL, {
      method: 'POST',
      // Overpass returns 406 without both of these: an explicit
      // Content-Type (Node's fetch, unlike a browser's, doesn't infer one
      // for a plain string body) and a real User-Agent identifying the
      // client (Node's default fetch UA gets filtered; Overpass's own
      // usage policy asks callers to identify themselves anyway).
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Meridian-Geocoding-Server/1.0 (+https://github.com/meridian-geocoding)',
      },
      body: overpassQuery,
      signal: AbortSignal.timeout((OVERPASS_TIMEOUT_SECONDS + 5) * 1000),
    });
  } catch (err) {
    throw new UpstreamError(`place search is temporarily unavailable: ${err.message}`);
  }

  if (response.status === 429) {
    throw new UpstreamError('place search is rate-limited right now -- try again in a minute');
  }
  if (!response.ok) {
    throw new UpstreamError(`place search is temporarily unavailable (status ${response.status})`);
  }

  const body = await response.json();
  const elements = Array.isArray(body.elements) ? body.elements : [];

  const seen = new Set();
  const results = [];
  let skipped = 0;
  for (const element of elements) {
    const tags = element.tags || {};
    const address = addressLineFromTags(tags);
    if (!address) {
      skipped += 1;
      continue;
    }
    if (seen.has(address)) continue; // multiple tag matches can hit the same node
    seen.add(address);
    results.push({ name: tags.name || address, address });
    if (results.length >= MAX_RESULTS) break;
  }

  return { results, skipped, truncated: results.length >= MAX_RESULTS };
}

module.exports = { searchPlaces, buildOverpassQuery, addressLineFromTags, MAX_RESULTS, MAX_RADIUS_METERS };
