const { isPlausiblyInCoverageArea } = require('./geocodeCoverage');
const { candidateStreetNames, matchByStreetAndZip } = require('./geocodeMatching');
const { isLlmAssistConfigured, pickCandidateWithLlm, describeCandidate } = require('./anthropicClient');
const { logLlmGeocodeAssist } = require('./llmGeocodeAssists');

/**
 * Tries to rescue a failed geocode() attempt via an LLM-assisted retry.
 * Returns a geocode()-shaped result (source: 'llm_assisted') on success,
 * or null if nothing could be done -- geocode() throws its normal
 * NotFoundError in that case, same as if this were never called.
 *
 * Checked in order, cheapest/most-likely-to-short-circuit first:
 * configured -> in coverage area -> has real candidates -> LLM call.
 * Only an attempt that reaches the LLM call is logged (see
 * llmGeocodeAssists.js) -- out-of-range, unconfigured, or
 * zero-candidate cases never reach the LLM at all, so there's nothing
 * about this feature's own activity to log for them.
 */
async function attemptLlmAssist(db, { usersDb, email }, parsed, originalInput, offsetFeet) {
  if (!isLlmAssistConfigured()) return null;

  const inCoverage = await isPlausiblyInCoverageArea(db, parsed);
  if (!inCoverage) return null;

  const candidates = await candidateStreetNames(db, parsed.streetName, {
    zip: parsed.zip,
    state: parsed.state,
  });
  if (candidates.length === 0) return null;

  const { picked, failureReason } = await pickCandidateWithLlm(originalInput, candidates);

  if (!picked) {
    await logLlmGeocodeAssist(usersDb, {
      email,
      originalInput,
      candidates,
      picked: null,
      succeeded: false,
      failureReason,
    });
    return null;
  }

  const zip = picked.zipl || picked.zipr;
  const result = await matchByStreetAndZip(db, parsed.number, picked.fullname, zip, parsed.state, offsetFeet);
  const correctedAddress = describeCandidate(picked);

  await logLlmGeocodeAssist(usersDb, {
    email,
    originalInput,
    candidates,
    picked: correctedAddress,
    succeeded: true,
    failureReason: null,
  });

  return {
    ...result,
    source: 'llm_assisted',
    originalInput,
    correctedAddress,
  };
}

module.exports = { attemptLlmAssist };
