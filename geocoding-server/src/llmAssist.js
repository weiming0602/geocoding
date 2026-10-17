const { isPlausiblyInCoverageArea } = require('./geocodeCoverage');
const { candidateStreetNames, matchByStreetAndZip } = require('./geocodeMatching');
const { isLlmAssistConfigured, pickCandidateWithLlm, describeCandidate } = require('./anthropicClient');
const { logLlmGeocodeAssist } = require('./llmGeocodeAssists');

// Conservative starting cap, not empirically tuned -- same "adjustable
// starting value" convention as CANDIDATE_SIMILARITY_THRESHOLD in
// geocodeMatching.js. Bounds a single authenticated account's LLM spend
// independent of quota: quota (useQuota in server.js) is only ever
// charged on a *successful* geocode, but this feature exists exclusively
// on the failure path, so today's quota charges nothing about how many
// times it fires -- this cap is the only thing that does.
const MAX_ASSISTS_PER_ACCOUNT_PER_DAY = 50;

/**
 * Tries to rescue a failed geocode() attempt via an LLM-assisted retry.
 * Returns a geocode()-shaped result (source: 'llm_assisted') on success,
 * or null if nothing could be done -- geocode() throws its normal
 * NotFoundError in that case, same as if this were never called.
 *
 * The entire attempt is wrapped so that ANY failure here -- a missing
 * pg_trgm extension on the geocoding database (candidateStreetNames
 * throws a plain DatabaseError in that case, not NotFoundError/
 * OutOfRangeError), a geocoding_users write failure, or anything else
 * unexpected -- degrades to null rather than escaping as a 500. This is
 * an optional enhancement; it must never make an authenticated request
 * fail *worse* than it would have with the feature disabled entirely.
 */
async function attemptLlmAssist(db, ctx, parsed, originalInput, offsetFeet) {
  try {
    return await attemptLlmAssistInner(db, ctx, parsed, originalInput, offsetFeet);
  } catch (err) {
    console.error('[llmAssist] assist attempt failed, falling through to NotFoundError:', err.message);
    return null;
  }
}

/**
 * Checked in order, cheapest/most-likely-to-short-circuit first:
 * configured -> in coverage area -> has real candidates -> under the
 * daily cap -> LLM call. Only an attempt that reaches the LLM call is
 * logged (see llmGeocodeAssists.js) -- out-of-range, unconfigured,
 * zero-candidate, or over-the-cap cases never reach the LLM at all, so
 * there's nothing about this feature's own activity to log for them.
 */
async function attemptLlmAssistInner(db, { usersDb, email }, parsed, originalInput, offsetFeet) {
  if (!isLlmAssistConfigured()) return null;

  const inCoverage = await isPlausiblyInCoverageArea(db, parsed);
  if (!inCoverage) return null;

  const candidates = await candidateStreetNames(db, parsed.streetName, {
    zip: parsed.zip,
    state: parsed.state,
  });
  if (candidates.length === 0) return null;

  const { rows: usageRows } = await usersDb.query(
    `SELECT count(*)::int AS n FROM llm_geocode_assists WHERE email = $1 AND created_at > now() - interval '1 day'`,
    [email]
  );
  if (usageRows[0].n >= MAX_ASSISTS_PER_ACCOUNT_PER_DAY) return null;

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

  // candidateStreetNames matched this candidate on EITHER side's ZIP
  // (zipl OR zipr -- see its own query), but matchByStreetAndZip only
  // ever queries the side the house number's own parity selects. Prefer
  // the caller's own ZIP when they gave one (guaranteed to match one of
  // the two sides, since that's what scoped the candidate query); only
  // fall back to the candidate's own ZIP, parity-aware, when the caller
  // gave none at all. Blindly preferring picked.zipl (the original,
  // buggy version of this line) silently handed over the wrong side's
  // ZIP whenever a street straddles a ZIP boundary (e.g. the "Greely Rd"
  // fixture: zipl 04021 / zipr 04097).
  const zip = parsed.zip
    || (parsed.number % 2 === 1 ? (picked.zipl || picked.zipr) : (picked.zipr || picked.zipl));
  const correctedAddress = describeCandidate(picked);

  let result;
  try {
    result = await matchByStreetAndZip(db, parsed.number, picked.fullname, zip, parsed.state, offsetFeet);
  } catch (err) {
    // The picked candidate's STREET NAME is real, but that doesn't
    // guarantee its address ranges cover this house number
    // (OutOfRangeError) or that it re-resolves at all under this exact
    // zip/state pairing (NotFoundError). Log the attempt either way so
    // the "one row per LLM call" invariant actually holds, rather than
    // silently losing attempts that got this far -- then let the outer
    // wrapper's catch (or geocode()'s own normal error handling, since
    // we return null here) produce the caller-facing failure.
    await logLlmGeocodeAssist(usersDb, {
      email,
      originalInput,
      candidates,
      picked: correctedAddress,
      succeeded: false,
      failureReason: 'rematch_failed',
    });
    return null;
  }

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
