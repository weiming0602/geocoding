/**
 * Provider-agnostic geo/classification helpers shared between
 * roadSignals.js (New England 511) and hereTraffic.js (HERE Traffic
 * API). Extracted out of roadSignals.js so both provider modules can
 * import from here without a circular require between them --
 * roadSignals.js needs to require hereTraffic.js for its geographic
 * dispatcher, and if hereTraffic.js required roadSignals.js back,
 * Node's CommonJS would hand it a still-initializing, incomplete module
 * (whichever file loads second in a require cycle sees the first one's
 * exports before that first file has finished running).
 */

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

/**
 * Most-recently-updated first, so a driver re-opening the list sees
 * what's newest at a glance rather than whatever order the upstream
 * provider happened to return it in. Falls back to `createdAt` when
 * `lastUpdatedAt` is missing -- `lastUpdatedAt` is still preferred when
 * both exist, since it reflects how current the information actually
 * is, not just when the incident was first reported. An incident with
 * neither timestamp sorts last (treated as oldest/least certain), not
 * first.
 */
function freshnessTimestamp(incident) {
  const raw = incident.lastUpdatedAt || incident.createdAt;
  if (!raw) return -Infinity;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function sortByFreshness(incidents) {
  return [...incidents].sort((a, b) => freshnessTimestamp(b) - freshnessTimestamp(a));
}

// The full set HAZARD_CATEGORY_ICONS (ui/shared/hazardCategories.ts) has
// an icon for -- kept here, not derived from that file, since this
// module has no business depending on a UI-layer file; the two are kept
// in sync by hand, same as ui/shared/api/types.ts already mirrors this
// server's response shapes by hand elsewhere in the codebase.
const HAZARD_CATEGORIES = [
  'hazmat',
  'accident',
  'construction',
  'closure',
  'congestion',
  'obstruction',
  'weather',
  'other',
];

/**
 * Keyword-matching hazard categorizer over freeform `eventType`/
 * `description` text -- shared by both providers since neither New
 * England 511 nor several of HERE's own incident types give a fully
 * structured hazard category. Checked most-specific/most-dangerous
 * first (a "chemical spill during a road closure" should read as
 * hazmat, not just a closure) down to the generic fallback `other`,
 * which is deliberately NOT the same bucket as a real category guess --
 * better to show a plain warning icon than a wrong specific one.
 */
function categorizeHazard({ raw511EventType, description }) {
  const text = `${raw511EventType || ''} ${description || ''}`.toLowerCase();
  if (/hazmat|hazardous material|chemical|fuel spill|gas leak|toxic/.test(text)) return 'hazmat';
  if (/accident|crash|collision/.test(text)) return 'accident';
  if (/construction|road work|roadwork|repav|paving|maintenance/.test(text)) return 'construction';
  if (/closed|closure/.test(text)) return 'closure';
  if (/congestion|heavy traffic|backup/.test(text)) return 'congestion';
  if (/disabled vehicle|debris|stall|obstruction/.test(text)) return 'obstruction';
  if (/flood|icy|ice|snow|weather|fog/.test(text)) return 'weather';
  return 'other';
}

module.exports = {
  boundingBoxDegrees,
  filterByBbox,
  sortByFreshness,
  HAZARD_CATEGORIES,
  categorizeHazard,
};
