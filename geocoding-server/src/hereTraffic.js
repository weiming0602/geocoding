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

module.exports = {
  isHereConfigured,
  mapHereSeverity,
  categorizeHereIncident,
  extractRoadwayFromDescription,
};
