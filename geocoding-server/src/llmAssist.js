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
  // (zipl OR zipr -- see its own query). Prefer the caller's own ZIP when
  // they gave one (guaranteed to match one of the two sides, since that's
  // what scoped the candidate query). With none, try each of the
  // candidate's own ZIPs: which side holds this house number (and so
  // which ZIP applies) isn't knowable from its parity alone -- see
  // geocodeMatching.js's sideFraction -- and matchByStreetAndZip itself
  // works out the side once it has the right ZIP. A street straddling a
  // ZIP boundary (the "Greely Rd" fixture: zipl 04021 / zipr 04097) is
  // exactly the case where picking one blindly goes wrong.
  const zipsToTry = parsed.zip ? [parsed.zip] : [...new Set([picked.zipl, picked.zipr].filter(Boolean))];
  const correctedAddress = describeCandidate(picked);

  let result = null;
  for (const zip of zipsToTry) {
    try {
      result = await matchByStreetAndZip(db, parsed.number, picked.fullname, zip, parsed.state, offsetFeet);
      break;
    } catch {
      // Try the next ZIP; if none works, the failure is logged just below.
    }
  }
  if (!result) {
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
