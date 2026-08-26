const { ValidationError, UpstreamError } = require('./errors');

// Public Overpass instance -- free, no API key, no billing account,
// consistent with how every other data source in this project is
// sourced (see DATA_SOURCES.md). It's the fallback search path (see
// searchPlaces), tried only when Nominatim's own search below comes up
// empty -- real-world testing found Overpass shared and rate-limited (2
// concurrent request slots per IP as of writing -- check
// https://overpass-api.de/api/status) enough to be unreliable as the
// primary path, and regex tag queries are noticeably more expensive
// than exact-match ones; both are why the query below is kept to two
// clauses, not one per tag per word.
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
// Kept short (rather than Overpass's own 180s max, or even the 15s this
// used to be back when Overpass was the primary search path) -- now
// that Overpass only runs after Nominatim has already come up empty, a
// slow failure here is pure dead time on top of whatever Nominatim
// already took, so failing fast (and leaving room for one retry -- see
// fetchOverpassWithRetry -- to land on a healthier backend) matters more
// than giving a single attempt every possible chance to succeed.
const OVERPASS_TIMEOUT_SECONDS = 8;
const OVERPASS_MAX_ATTEMPTS = 2;
const MAX_RESULTS = 200;
const MAX_RADIUS_METERS = 25000;

// OSM's own place-name search (a different service from Overpass --
// Overpass has no free-text/place-name lookup at all) -- resolves a
// "near <place>" clause (see parseNearQuery) to coordinates, so a query
// like "barber shop near Brunswick, Maine" doesn't require first
// clicking a point on the map. Free, no API key, but a stricter usage
// policy than Overpass's: max 1 request/second and a real User-Agent
// (both fine here -- one lookup per user-initiated search, never
// batched). https://operations.osmfoundation.org/policies/nominatim/
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_TIMEOUT_MS = 10000;
// Nominatim's own POI search results, capped independently of MAX_RESULTS --
// there's no reason to ask for more than a page's worth up front.
const NOMINATIM_SEARCH_LIMIT = 50;

// Nominatim's usage policy is an absolute max of 1 request/second --
// stricter than Overpass's, and now load-bearing (searchPlaces below
// calls it for both the "near <place>" lookup and the place search
// itself, up to twice per user search). A per-process last-call
// timestamp enforces this across every caller sharing this module,
// regardless of how many call sites end up hitting Nominatim -- getting
// this wrong risks the whole shared instance blocking this server's IP
// entirely, which would be worse than today's occasional slow query.
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimCallAt = 0;
async function throttleNominatim() {
  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimCallAt = Date.now();
}

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
 * Splits "barber shop near Brunswick, Maine" into `{ terms: 'barber
 * shop', locationPhrase: 'Brunswick, Maine' }`. Only the last "near"
 * counts as the split point (rightmost, not first) -- there's no reason
 * a place name itself would contain the word "near", but a query
 * plausibly could ("things to do near near Brunswick" is unlikely, but
 * matching last keeps `terms` intact even in that edge case). Returns
 * `locationPhrase: null` when there's no "near" clause at all, or when
 * either side would be empty -- callers fall back to requiring an
 * explicit latitude/longitude in that case.
 */
function parseNearQuery(query) {
  const trimmed = query.trim();
  const match = /^(.*)\s+near\s+(.+)$/i.exec(trimmed);
  if (!match) return { terms: trimmed, locationPhrase: null };
  const terms = match[1].trim();
  const locationPhrase = match[2].trim();
  if (!terms || !locationPhrase) return { terms: trimmed, locationPhrase: null };
  return { terms, locationPhrase };
}

/**
 * Resolves a place name (a town, a street, a landmark -- anything
 * Nominatim's own search covers) to coordinates via OSM's Nominatim.
 * Throws ValidationError (the user's fault -- try a more specific
 * phrase) when nothing matches, UpstreamError (Nominatim's fault) for
 * a network failure or non-2xx response, matching the same split
 * `searchPlaces` already uses for Overpass failures.
 */
async function geocodePlaceName(locationPhrase) {
  await throttleNominatim();
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(locationPhrase)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Meridian-Geocoding-Server/1.0 (+https://github.com/meridian-geocoding)',
      },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(`could not look up "${locationPhrase}": ${err.message}`);
  }
  if (!response.ok) {
    throw new UpstreamError(`could not look up "${locationPhrase}" (status ${response.status})`);
  }
  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new ValidationError(
      `couldn't find a location matching "${locationPhrase}" -- try being more specific, or click a point on the map instead`
    );
  }
  const latitude = parseFloat(results[0].lat);
  const longitude = parseFloat(results[0].lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new UpstreamError(`Nominatim returned an unusable location for "${locationPhrase}"`);
  }
  return { latitude, longitude };
}

/**
 * Converts a center point + radius into Nominatim's viewbox format
 * (minLon,minLat,maxLon,maxLat) -- an approximation (flat-earth degrees,
 * not a true geodesic circle) that's more than accurate enough for
 * constraining a place search, same spirit as Overpass's own `around`.
 */
function metersToViewbox(latitude, longitude, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.cos((latitude * Math.PI) / 180));
  return [longitude - lonDelta, latitude - latDelta, longitude + lonDelta, latitude + latDelta].join(',');
}

/**
 * Builds a Meridian-format address line from Nominatim's `addressdetails`
 * object, or null if there isn't enough to form one -- same
 * house-number/street/ZIP requirement as addressLineFromTags. `city` is
 * whichever of Nominatim's several place-size fields is actually present
 * (a town/village/hamlet has no `city` field at all).
 */
function addressLineFromNominatim(address) {
  const houseNumber = address.house_number;
  const road = address.road;
  const postcode = address.postcode;
  if (!houseNumber || !road || !postcode) return null;

  const city = address.city || address.town || address.village || address.hamlet;
  const state = address.state;
  const cityState = [city, state].filter(Boolean).join(', ');
  const middle = cityState ? `, ${cityState}` : '';
  return `${houseNumber} ${road}${middle} ${postcode}`.replace(/\s+/g, ' ').trim();
}

/**
 * Searches Nominatim itself for places matching `terms` within
 * `radiusMeters` of (latitude, longitude) -- tried first in searchPlaces
 * below, before ever touching Overpass. Fast and usually reliable, but
 * Nominatim only matches literal text: a business's own name, or an
 * exact OSM taxonomy word (e.g. "restaurant" matches every
 * amenity=restaurant node) -- a colloquial category term like "pizza"
 * that only exists as a cuisine tag, not a name or a type value, won't
 * match here at all. That gap is exactly what the Overpass fallback
 * covers. Returns `{ results: [], skipped: 0 }` on a clean zero-result
 * search (not an error -- searchPlaces treats an empty result set as
 * "try Overpass instead", not a failure).
 */
async function searchNominatimPlaces(terms, latitude, longitude, radiusMeters) {
  await throttleNominatim();
  const viewbox = metersToViewbox(latitude, longitude, radiusMeters);
  const url =
    `${NOMINATIM_URL}?format=json&addressdetails=1&bounded=1` +
    `&limit=${NOMINATIM_SEARCH_LIMIT}&viewbox=${viewbox}&q=${encodeURIComponent(terms)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Meridian-Geocoding-Server/1.0 (+https://github.com/meridian-geocoding)',
      },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(`place search via Nominatim failed: ${err.message}`);
  }
  if (!response.ok) {
    throw new UpstreamError(`place search via Nominatim failed (status ${response.status})`);
  }

  const elements = await response.json();
  const seen = new Set();
  const results = [];
  let skipped = 0;
  for (const element of Array.isArray(elements) ? elements : []) {
    const address = addressLineFromNominatim(element.address || {});
    if (!address) {
      skipped += 1;
      continue;
    }
    const latitude = parseFloat(element.lat);
    const longitude = parseFloat(element.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      skipped += 1;
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    results.push({ name: element.name || address, address, latitude, longitude });
    if (results.length >= MAX_RESULTS) break;
  }
  return { results, skipped };
}

/**
 * POSTs one attempt to Overpass and returns the parsed JSON body, or
 * throws UpstreamError. The free instance is load-balanced across
 * several backend mirrors (the "Announced endpoint" in
 * https://overpass-api.de/api/status varies call to call) of uneven,
 * fluctuating load -- an attempt landing on a busy one can time out
 * even when Overpass overall has free capacity, so
 * fetchOverpassWithRetry below gives a second attempt a chance to land
 * somewhere lighter rather than failing the whole search on one slow
 * backend. 429 (rate-limited) is not retried -- hitting the same 2-
 * slot-per-IP limit again immediately would just make it worse.
 */
async function fetchOverpassOnce(overpassQuery) {
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
      signal: AbortSignal.timeout((OVERPASS_TIMEOUT_SECONDS + 3) * 1000),
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
  return response.json();
}

async function fetchOverpassWithRetry(overpassQuery) {
  let lastErr;
  for (let attempt = 1; attempt <= OVERPASS_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchOverpassOnce(overpassQuery);
    } catch (err) {
      lastErr = err;
      if (/rate-limited/.test(err.message)) throw err; // don't hammer a limit we just hit
    }
  }
  throw lastErr;
}

/**
 * Searches for places matching `query`, extracting a Meridian-geocodable
 * address line from each result that has one. Tries Nominatim first
 * (searchNominatimPlaces -- fast, usually reliable, but misses
 * colloquial category terms), falling back to Overpass (buildOverpassQuery
 * -- broader recall via regex tag matching, but the less reliable of the
 * two) only when Nominatim comes back empty or fails outright. Results
 * with a name/coordinate but no usable street address are counted in
 * `skipped`, not silently dropped. Throws UpstreamError (not a generic
 * Error) for anything that's Overpass's (or Nominatim's) fault -- a
 * timeout, a rate limit, a non-2xx response -- so callers can tell "the
 * free public service is having a moment" apart from a real bug.
 *
 * `latitude`/`longitude` are optional when `query` contains a "near
 * <place>" clause (see parseNearQuery) -- that place name is geocoded
 * via Nominatim and always takes priority over any explicit
 * coordinates passed in, on the theory that what the user just typed
 * is a stronger signal of intent than a possibly-stale map click.
 * Without a "near" clause, `latitude`/`longitude` are required, same as
 * before this existed. The response's `center` field reports back
 * whatever coordinates were actually searched from, so a caller (e.g.
 * the map) can reflect where a "near <place>" query actually landed.
 */
async function searchPlaces(query, latitude, longitude, radiusMeters) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ValidationError('query must be a non-empty string');
  }
  if (typeof radiusMeters !== 'number' || radiusMeters <= 0) {
    throw new ValidationError('radiusMeters must be a positive number');
  }
  if (radiusMeters > MAX_RADIUS_METERS) {
    throw new ValidationError(`radiusMeters must be at most ${MAX_RADIUS_METERS}`);
  }

  const { terms, locationPhrase } = parseNearQuery(query);

  let resolvedLatitude = latitude;
  let resolvedLongitude = longitude;
  if (locationPhrase) {
    const resolved = await geocodePlaceName(locationPhrase);
    resolvedLatitude = resolved.latitude;
    resolvedLongitude = resolved.longitude;
  } else if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new ValidationError(
      'latitude and longitude must be numbers, or include "near <place>" in the query'
    );
  }

  const words = queryWords(terms);
  if (words.length === 0) {
    throw new ValidationError('query must contain at least one word');
  }

  const center = locationPhrase ? { latitude: resolvedLatitude, longitude: resolvedLongitude } : undefined;

  // Nominatim first -- fast and usually reliable, at the cost of missing
  // colloquial category terms (see searchNominatimPlaces). A clean
  // zero-result search or any Nominatim-side failure both fall through
  // to Overpass rather than giving up; only Overpass's own failure is
  // actually surfaced to the caller, since by that point it's the last
  // thing that was tried.
  try {
    const nominatimResult = await searchNominatimPlaces(terms, resolvedLatitude, resolvedLongitude, radiusMeters);
    if (nominatimResult.results.length > 0) {
      return {
        ...nominatimResult,
        truncated: nominatimResult.results.length >= MAX_RESULTS,
        center,
      };
    }
  } catch {
    // Fall through to Overpass.
  }

  const overpassQuery = buildOverpassQuery(words, resolvedLatitude, resolvedLongitude, radiusMeters);
  const body = await fetchOverpassWithRetry(overpassQuery);
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
    if (!Number.isFinite(element.lat) || !Number.isFinite(element.lon)) {
      skipped += 1;
      continue;
    }
    if (seen.has(address)) continue; // multiple tag matches can hit the same node
    seen.add(address);
    results.push({ name: tags.name || address, address, latitude: element.lat, longitude: element.lon });
    if (results.length >= MAX_RESULTS) break;
  }

  return {
    results,
    skipped,
    truncated: results.length >= MAX_RESULTS,
    center,
  };
}

module.exports = {
  searchPlaces,
  buildOverpassQuery,
  addressLineFromTags,
  parseNearQuery,
  addressLineFromNominatim,
  metersToViewbox,
  MAX_RESULTS,
  MAX_RADIUS_METERS,
  OVERPASS_MAX_ATTEMPTS,
};
