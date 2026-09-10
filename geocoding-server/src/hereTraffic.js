// Real, working, paid alternative to New England 511 for everywhere
// NE511 doesn't cover (see docs/ROAD_ALERTS_DESIGN.md's "Texas coverage"
// section for the research trail, and
// docs/superpowers/specs/2026-09-10-here-traffic-provider-design.md for
// the full design). 30,000 free transactions/month, no credit card --
// confirmed live against real Dallas/Portland locations before this was
// built.

const { categorizeHazard } = require('./roadSignalsShared');

/** Whether HERE_API_KEY is set -- mirrors billing.js's isConfigured() pattern for an optional paid integration. */
function isHereConfigured() {
  return Boolean(process.env.HERE_API_KEY);
}

/**
 * Unlike New England 511 (no structured severity field, forcing
 * roadSignals.js's mapSeverity to guess from keywords), HERE gives
 * structured fields directly -- mapped here rather than degraded back
 * through a keyword matcher, which would throw away real signal.
 * roadClosed/type==='roadClosure'/criticality==='critical' all bump to
 * `serious`, mirroring New England 511's own "closure bumps to serious
 * regardless" rule.
 */
function mapHereSeverity({ criticality, roadClosed, type }) {
  if (roadClosed || type === 'roadClosure' || criticality === 'critical') return 'serious';
  if (criticality === 'major') return 'need_to_know';
  return 'proximity';
}

// Direct type->category mapping for the HERE `type` values confirmed by
// live sampling to line up cleanly with this app's hazard categories.
// HERE's real `type` enum is likely broader than these four -- anything
// else falls through to the shared categorizeHazard() keyword matcher,
// which is what catches hazmat/accident/weather even though they
// weren't in HERE's `type` enum as sampled.
const HERE_TYPE_TO_CATEGORY = {
  construction: 'construction',
  roadClosure: 'closure',
  congestion: 'congestion',
  laneRestriction: 'obstruction',
};

function categorizeHereIncident({ type, typeDescription, description }) {
  const direct = HERE_TYPE_TO_CATEGORY[type];
  if (direct) return direct;
  return categorizeHazard({
    raw511EventType: typeDescription?.value,
    description: description?.value,
  });
}

/**
 * HERE has no separate structured roadway field like New England 511
 * does -- description text commonly follows an "At {roadway} - {detail}"
 * pattern (confirmed by live sampling: construction/congestion/
 * plannedEvent/other incidents all matched this shape; roadClosure/
 * laneRestriction incidents in the same sample did not and fall back to
 * null, same as the UI's existing `signal.roadway ?? 'Unknown road'`
 * already handles for a New England 511 incident with no roadway).
 */
function extractRoadwayFromDescription(description) {
  const match = /^At (.+?) - /.exec(description || '');
  return match ? match[1] : null;
}

/**
 * A HERE incident's `location` describes a road segment (one or more
 * `links`, each a polyline of `points`), not a single point -- this
 * app's RoadSignal needs one representative latitude/longitude (for map
 * markers and bbox filtering), so this takes the first point of the
 * first link. A location with no shape data at all returns nulls, same
 * as roadSignals.js's normalizeIncident does for a New England 511
 * incident with no usable coordinates.
 */
function firstShapePoint(location) {
  const firstPoint = location?.shape?.links?.[0]?.points?.[0];
  if (!firstPoint) return { latitude: null, longitude: null };
  return { latitude: firstPoint.lat, longitude: firstPoint.lng };
}

/**
 * Normalizes one raw HERE `results[]` entry into this app's RoadSignal
 * shape -- same fields roadSignals.js's normalizeIncident produces for
 * New England 511, so downstream code (the GET /road-signals route,
 * roadAlertsMatching) never needs to know which provider produced a
 * given signal.
 *
 * createdAt and lastUpdatedAt both use `entryTime` (when HERE's system
 * recorded this incident) -- HERE's `startTime` is about the real-world
 * incident's own timing (e.g. a construction window that opened days
 * ago), not about how recently the record itself was touched, so using
 * it for `lastUpdatedAt` would make an old-but-still-current incident
 * sort as stale. `raw511Severity`/`raw511EventType` are named for New
 * England 511's own raw fields but are part of the public RoadSignal API
 * type regardless of provider (see ui/shared/api/types.ts) --
 * raw511EventType is populated with HERE's own typeDescription text
 * (the closest equivalent), raw511Severity stays null since HERE's
 * criticality tiers aren't a comparable raw string.
 */
function normalizeHereIncident(raw) {
  const details = raw.incidentDetails;
  const { latitude, longitude } = firstShapePoint(raw.location);
  const roadway = extractRoadwayFromDescription(details.description?.value);

  const normalized = {
    id: details.id,
    type: 'traffic_hazard',
    source: 'HERE Traffic API',
    network: 'HERE',
    status: null,
    roadway,
    direction: null,
    crossStreet: null,
    mileMarker: null,
    county: null,
    city: null,
    latitude,
    longitude,
    affectedLanes: null,
    affectedLanesDetail: null,
    weightRestriction: null,
    description: details.description?.value || null,
    verifiedBy: null,
    createdAt: details.entryTime || null,
    lastUpdatedAt: details.entryTime || null,
    raw511Severity: null,
    raw511EventType: details.typeDescription?.value || null,
  };

  normalized.severity = mapHereSeverity(details);
  normalized.hazardCategory = categorizeHereIncident(details);
  normalized.speech = {
    brief: details.summary?.value || details.typeDescription?.value || 'Traffic incident nearby.',
    average: details.description?.value || details.summary?.value || 'Traffic incident nearby.',
    deep: details.description?.value || details.summary?.value || 'Traffic incident nearby.',
  };

  return normalized;
}

module.exports = {
  isHereConfigured,
  mapHereSeverity,
  categorizeHereIncident,
  extractRoadwayFromDescription,
  normalizeHereIncident,
};
