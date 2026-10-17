// ME ZIP codes start 039-049; NH ZIP codes start 030-038. Both ranges
// are contiguous, so one bounds check covers both states at once.
const ZIP_PREFIX_MIN = 30;
const ZIP_PREFIX_MAX = 49;

const ME_NH_STATE_ABBRS = new Set(['ME', 'NH']);
const ME_NH_STATE_NAMES = new Set(['MAINE', 'NEW HAMPSHIRE']);

/**
 * Classifies, from state/zip alone (no DB access, no network), whether a
 * parsed address is plausibly within Meridian's Maine/New Hampshire
 * coverage area. Returns 'in' | 'out' | 'inconclusive'.
 *
 * An explicit state is the strongest signal and is checked first, ahead
 * of a ZIP that might contradict it -- a caller who typed a real state
 * code almost certainly meant it, even if they fat-fingered the ZIP.
 */
function classifyCoverage({ zip, state }) {
  if (state) {
    const normalized = state.toUpperCase();
    if (state.length === 2) {
      return ME_NH_STATE_ABBRS.has(normalized) ? 'in' : 'out';
    }
    return ME_NH_STATE_NAMES.has(normalized) ? 'in' : 'out';
  }

  if (zip) {
    const prefix = parseInt(zip.slice(0, 3), 10);
    if (Number.isNaN(prefix)) return 'inconclusive';
    return prefix >= ZIP_PREFIX_MIN && prefix <= ZIP_PREFIX_MAX ? 'in' : 'out';
  }

  return 'inconclusive';
}

/**
 * Full coverage check, including the DB-backed town fallback for the
 * 'inconclusive' case (no state, no zip, or an unparseable zip) -- checks
 * the given town against address_points.town. address_points is Maine E911
 * data only (NH has zero address-point coverage, confirmed in CLAUDE.md's
 * Known Gaps), so an inconclusive NH town -- or any town we simply don't
 * recognize -- falls through to the same "allow" default as a town with
 * no match at all: false negatives here (skipping a legitimately fixable
 * ME/NH address) cost more than the rare false positive of one wasted LLM
 * call on an address that turns out to be elsewhere.
 */
async function isPlausiblyInCoverageArea(db, { zip, state, town }) {
  const classified = classifyCoverage({ zip, state });
  if (classified === 'in') return true;
  if (classified === 'out') return false;

  if (town) {
    const { rows } = await db.query('SELECT 1 FROM address_points WHERE UPPER(town) = UPPER($1) LIMIT 1', [town]);
    if (rows.length > 0) return true;
  }

  return true;
}

module.exports = { classifyCoverage, isPlausiblyInCoverageArea };
