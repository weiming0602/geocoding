// Real, working, paid alternative to New England 511 for everywhere
// NE511 doesn't cover (see docs/ROAD_ALERTS_DESIGN.md's "Texas coverage"
// section for the research trail, and
// docs/superpowers/specs/2026-09-10-here-traffic-provider-design.md for
// the full design). 30,000 free transactions/month, no credit card --
// confirmed live against real Dallas/Portland locations before this was
// built.

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

module.exports = {
  isHereConfigured,
  mapHereSeverity,
};
