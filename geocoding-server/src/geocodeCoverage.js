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
 * Full coverage check for the 'inconclusive' case (no state, no zip, or
 * an unparseable zip) -- always allows. A town given here can't be
 * decisively checked either way: a match against address_points (Maine
 * E911 data only) would confirm "in range," but a non-match proves
 * nothing, since address_points has no NH coverage at all (CLAUDE.md's
 * Known Gaps) -- a real New Hampshire town would "fail" this lookup too.
 * With no way to safely reject on a non-match, there was never a
 * decisive answer to compute here: false negatives (skipping a
 * legitimately fixable ME/NH address) cost more than the rare false
 * positive of one wasted LLM call on an address that turns out to be
 * elsewhere.
 */
async function isPlausiblyInCoverageArea(db, { zip, state, town }) {
  const classified = classifyCoverage({ zip, state });
  if (classified === 'in') return true;
  if (classified === 'out') return false;

  return true;
}

module.exports = { classifyCoverage, isPlausiblyInCoverageArea };
