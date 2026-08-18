const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { ValidationError, UpstreamError } = require('./errors');

// Free, public, no API key or registration -- confirmed directly against
// the New England 511 developer portal (nec-por.ne-compass.com/
// DeveloperPortal). Commercial use is explicitly permitted; the only
// obligations are attribution and never claiming ownership/affiliation
// (see docs/ROAD_ALERTS_DESIGN.md's "New England 511 -- confirmed access"
// section). No combined multi-state `networks` param is documented, so
// each state is fetched as its own request.
const NE511_BASE_URL =
  process.env.NE511_BASE_URL || 'https://nec-por.ne-compass.com/NEC.XmlDataPortal/api/c2c';
const NE511_NETWORKS = ['Maine', 'NewHampshire', 'Vermont'];
const NE511_TIMEOUT_MS = 10000;
const MAX_RADIUS_METERS = 40000;
// Multiple mobile clients can poll this endpoint every ~15s each; caching
// each state's raw incident list this long avoids re-fetching the same
// upstream data for every request, same spirit as placesSearch.js's
// Nominatim throttling but for repeat reads rather than a rate limit.
const NETWORK_CACHE_TTL_MS = 15000;

const networkCache = new Map(); // network -> { at, incidents }

/**
 * fast-xml-parser collapses a single repeated element to a bare object
 * instead of a 1-item array (e.g. one <incident> vs several) -- every
 * place that reads a possibly-repeated node must go through this rather
 * than assuming an array.
 */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseIncidentsXml(xmlText) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  return parser.parse(xmlText);
}

function extractIncidents(parsed, network) {
  const nets = asArray(parsed?.status?.incidentData?.net);
  const incidents = [];
  for (const net of nets) {
    for (const incident of asArray(net?.incident)) {
      incidents.push({ raw: incident, network });
    }
  }
  return incidents;
}

/**
 * Maps 511's own `severity` field to this app's four-tier scale (see
 * docs/ROAD_ALERTS_DESIGN.md's content model). Confirmed by live sampling
 * across all 3 networks (see the manual curl verification step): observed
 * values are Low/High/Severe (Maine, Vermont), Severe (New Hampshire) --
 * Moderate wasn't seen in the sample but is assumed to sit at
 * need_to_know, consistent with the observed Low->proximity/High-or-
 * Severe->serious spread. A closure/emergency is bumped to `serious`
 * regardless of 511's own severity rating -- a low-severity-rated bridge
 * weight restriction and an actual road closure shouldn't share a tier
 * just because 511 called them both "Low"/"Other". No usable severity
 * value at all falls back to eventType/description keywords, defaulting
 * conservatively to `need_to_know` (not `fun_to_know`) per the design
 * doc's "alert anyway" bias under uncertainty.
 */
function mapSeverity({ raw511Severity, raw511EventType, description }) {
  const text = `${raw511EventType || ''} ${description || ''}`.toLowerCase();
  if (/closed|closure|emergency/.test(text)) return 'serious';

  const severity = (raw511Severity || '').toLowerCase();
  if (severity === 'severe' || severity === 'high') return 'serious';
  if (severity === 'moderate') return 'need_to_know';
  if (severity === 'low') return 'proximity';

  if (/accident|crash|construction|delay/.test(text)) return 'need_to_know';
  if (/disabled vehicle|debris|stall/.test(text)) return 'proximity';
  return 'need_to_know';
}

/**
 * 511 has no separate short/long description field -- synthesizes the
 * brief/average/deep tiers the mobile app's detail-level setting reads
 * from (docs/ROAD_ALERTS_DESIGN.md's "Delivery channels" section) out of
 * whatever fields a given incident actually has.
 */
function buildSpeech(normalized) {
  const what = normalized.raw511EventType || 'Traffic incident';
  const where = normalized.roadway ? `on ${normalized.roadway}` : 'nearby';
  const brief = `${what} ${where}.`;

  const lane = normalized.affectedLanes ? `, ${normalized.affectedLanes}` : '';
  const dir = normalized.direction ? `, ${normalized.direction} direction` : '';
  const average = `${what} ${where}${lane}${dir}.`;

  const deepParts = [
    normalized.description,
    normalized.affectedLanesDetail,
    normalized.weightRestriction ? `Weight restriction: ${normalized.weightRestriction}.` : null,
  ].filter(Boolean);
  const deep = deepParts.length ? deepParts.join(' ') : average;

  return { brief, average, deep };
}

function stableId({ roadway, latitude, longitude, createdAt }) {
  return crypto
    .createHash('sha1')
    .update(`${roadway || ''}|${latitude || ''}|${longitude || ''}|${createdAt || ''}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * `affectedLanesDetail` is structured XML (a `<laneDetails>` element per
 * lane, each carrying `type`/`status`/`index` as attributes -- confirmed
 * by live sampling), not plain text -- naively string-interpolating the
 * parsed object into a spoken sentence would say "[object Object]".
 * Reduces it to a short human-readable summary instead; a plain string
 * (if some incident ever carries one directly) passes through unchanged.
 */
function formatLaneDetail(detail) {
  if (detail === undefined || detail === null || detail === '') return null;
  if (typeof detail === 'string') return detail;
  const lanes = asArray(detail.laneDetails);
  if (lanes.length === 0) return null;
  return lanes
    .map((lane) => `${lane['@_type'] || 'lane'} ${(lane['@_status'] || 'unknown').toLowerCase()}`)
    .join(', ');
}

/**
 * `roadRestrictions/weight` was assumed to be descriptive text ("30 Ton")
 * before live sampling -- it's actually a plain number in pounds (e.g.
 * 60000). Handles both shapes defensively rather than assuming the
 * numeric form is universal across every incident/network.
 */
function formatWeightRestriction(weight) {
  if (weight === undefined || weight === null || weight === '') return null;
  return typeof weight === 'number' ? `${weight} lbs` : String(weight);
}

function normalizeIncident(raw, network) {
  const location = raw.startLocation || {};
  const restrictions = raw.roadRestrictions || {};

  const attributeId = raw['@_id'] || raw['@_incidentId'] || null;
  // Confirmed by live sampling (all 3 networks): lat/lon are integer
  // microdegrees, not decimal degrees -- e.g. 44912454 means 44.912454.
  // Scaling by 1e-6 converts to the plain decimal degrees every other
  // coordinate in this codebase already uses; rounded back to 6 decimal
  // places (microdegree precision, no more no less) to avoid exposing
  // binary floating-point noise (e.g. 44.933299999999996) in the response.
  const latitude = location.lat !== undefined ? Math.round(parseFloat(location.lat)) / 1e6 : null;
  const longitude = location.lon !== undefined ? Math.round(parseFloat(location.lon)) / 1e6 : null;
  const createdAt = raw.createdTimestamp || null;
  const roadway = location.roadway || null;

  const normalized = {
    id: attributeId || stableId({ roadway, latitude, longitude, createdAt }),
    type: 'traffic_hazard',
    source: 'New England 511',
    network,
    status: raw.status || null,
    roadway,
    direction: location.direction || null,
    crossStreet: location.crossstreet || null,
    mileMarker: location.mileMarker || null,
    county: location.county || null,
    city: location.city || null,
    latitude,
    longitude,
    affectedLanes: raw.affectedLanes || null,
    affectedLanesDetail: formatLaneDetail(raw.affectedLanesDetail),
    weightRestriction: formatWeightRestriction(restrictions.weight),
    description: raw.desc || null,
    verifiedBy: raw.verifiedBy || null,
    createdAt,
    lastUpdatedAt: raw.lastUpdatedTimestamp || null,
    raw511Severity: raw.severity || null,
    raw511EventType: raw.eventType || null,
  };

  normalized.severity = mapSeverity(normalized);
  normalized.speech = buildSpeech(normalized);

  return normalized;
}

/**
 * Flat rectangle approximation (not a true geodesic circle), same
 * approach as placesSearch.js's metersToViewbox -- more than accurate
 * enough for "what's roughly nearby" filtering.
 */
function boundingBoxDegrees(latitude, longitude, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.cos((latitude * Math.PI) / 180));
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLon: longitude - lonDelta,
    maxLon: longitude + lonDelta,
  };
}

function filterByBbox(incidents, latitude, longitude, radiusMeters) {
  const box = boundingBoxDegrees(latitude, longitude, radiusMeters);
  return incidents.filter(
    (incident) =>
      typeof incident.latitude === 'number' &&
      typeof incident.longitude === 'number' &&
      incident.latitude >= box.minLat &&
      incident.latitude <= box.maxLat &&
      incident.longitude >= box.minLon &&
      incident.longitude <= box.maxLon
  );
}

async function fetchNetworkIncidents(network) {
  const url = `${NE511_BASE_URL}?networks=${network}&dataTypes=incidentData`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Meridian-Geocoding-Server/1.0 (+https://github.com/meridian-geocoding)',
      },
      signal: AbortSignal.timeout(NE511_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(`New England 511 (${network}) is temporarily unavailable: ${err.message}`);
  }
  if (!response.ok) {
    throw new UpstreamError(`New England 511 (${network}) is temporarily unavailable (status ${response.status})`);
  }
  const xmlText = await response.text();
  const parsed = parseIncidentsXml(xmlText);
  return extractIncidents(parsed, network).map(({ raw, network: net }) => normalizeIncident(raw, net));
}

async function fetchNetworkIncidentsCached(network) {
  const cached = networkCache.get(network);
  if (cached && Date.now() - cached.at < NETWORK_CACHE_TTL_MS) {
    return cached.incidents;
  }
  const incidents = await fetchNetworkIncidents(network);
  networkCache.set(network, { at: Date.now(), incidents });
  return incidents;
}

/**
 * Fetches live traffic-hazard incidents across Maine/NH/Vermont and
 * returns those within `radiusMeters` of (latitude, longitude). Fetches
 * every network in parallel via Promise.allSettled -- a single state's
 * upstream failure shouldn't fail the whole request, so `partial: true`
 * plus `failedNetworks` reports a degraded result instead of throwing,
 * unless every network failed, in which case there's nothing usable to
 * return at all.
 */
async function getRoadSignals({ latitude, longitude, radiusMeters }) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError('latitude must be a number');
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError('longitude must be a number');
  }
  if (typeof radiusMeters !== 'number' || radiusMeters <= 0) {
    throw new ValidationError('radiusMeters must be a positive number');
  }
  if (radiusMeters > MAX_RADIUS_METERS) {
    throw new ValidationError(`radiusMeters must be at most ${MAX_RADIUS_METERS}`);
  }

  const settled = await Promise.allSettled(NE511_NETWORKS.map(fetchNetworkIncidentsCached));
  const incidents = [];
  const failedNetworks = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      incidents.push(...result.value);
    } else {
      failedNetworks.push(NE511_NETWORKS[index]);
    }
  });
  if (failedNetworks.length === NE511_NETWORKS.length) {
    throw new UpstreamError('New England 511 is temporarily unavailable');
  }

  return {
    signals: filterByBbox(incidents, latitude, longitude, radiusMeters),
    networks: NE511_NETWORKS,
    partial: failedNetworks.length > 0,
    failedNetworks,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getRoadSignals,
  asArray,
  parseIncidentsXml,
  extractIncidents,
  normalizeIncident,
  mapSeverity,
  buildSpeech,
  formatLaneDetail,
  formatWeightRestriction,
  boundingBoxDegrees,
  filterByBbox,
  MAX_RADIUS_METERS,
};
