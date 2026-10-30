const { isPlausiblyInCoverageArea } = require('./geocodeCoverage');
const {
  candidateStreetNames,
  candidateStreetNamesInTown,
  matchByStreetAndZip,
  matchByStreetAndTown,
  queryTowns,
  MAX_CANDIDATES,
} = require('./geocodeMatching');
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
// Batch runs have their own, larger allowance -- a messy customer file is
// exactly where this earns its keep -- counted separately from single
// geocodes (llm_geocode_assists.context). At roughly $0.001-0.002 per
// attempt (Claude Haiku), the daily cap bounds a single account's worst
// case at a dollar or two a day.
const MAX_BATCH_ASSISTS_PER_ACCOUNT_PER_DAY = 1000;
// ...and at most this many attempts in any one batch run.
const MAX_ASSISTS_PER_BATCH_RUN = 200;

// A rescued result farther than this from the town the address names is
// rejected -- see correctionFitsNamedTown.
const MAX_DISTANCE_FROM_NAMED_TOWN_METERS = 5000;

/**
 * Whether a corrected result is plausibly in the town the address names.
 * Candidates from the address's own ZIP can be wrong when that ZIP is
 * wrong too -- a similar-sounding street in another town: a real batch row
 * "16 Sammer St, Augusta, ME 04074" (04074 is Scarborough) came back as
 * Sawyer St in Scarborough, 90 km away. A failed row is visible; a
 * confidently wrong one isn't. Checked against the town's boundary
 * (towns) and Maine E911 address points' towns -- a town in neither (a
 * misspelled town name, or no towns table yet) can't be checked, so it's
 * let through.
 */
async function correctionFitsNamedTown(db, town, coordinates) {
  if (!town || !coordinates) return true;
  const townRows = await queryTowns(
    db,
    `SELECT bool_or(ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)) AS near
     FROM towns WHERE UPPER(name) = UPPER($1)`,
    [town.trim(), coordinates.longitude, coordinates.latitude, MAX_DISTANCE_FROM_NAMED_TOWN_METERS]
  );
  // bool_or over no rows is NULL: no such town in the table.
  const townNear = townRows ? townRows[0].near : null;
  if (townNear !== null) return townNear;

  const { rows } = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM address_points WHERE upper(town) = upper($1)) AS town_known,
       EXISTS (
         SELECT 1 FROM address_points
         WHERE upper(town) = upper($1)
           AND geom && ST_Expand(ST_SetSRID(ST_MakePoint($2, $3), 4326), 0.07)
           AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
       ) AS near`,
    [town.trim(), coordinates.longitude, coordinates.latitude, MAX_DISTANCE_FROM_NAMED_TOWN_METERS]
  );
  return !rows[0].town_known || rows[0].near;
}

/**
 * The llmAssist context for one authenticated batch run: batch's own
 * daily cap, plus a per-run budget shared by every row of the run.
 */
function batchLlmAssist(usersDb, email) {
  return { usersDb, email, context: 'batch', runBudget: { remaining: MAX_ASSISTS_PER_BATCH_RUN } };
}

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
async function attemptLlmAssistInner(
  db,
  { usersDb, email, context = 'single', runBudget = null },
  parsed,
  originalInput,
  offsetFeet
) {
  if (!isLlmAssistConfigured()) return null;

  const inCoverage = await isPlausiblyInCoverageArea(db, parsed);
  if (!inCoverage) return null;

  // The named town's own similar streets first (they're what the town-
  // first match in geocode.js would have used), then the ZIP's.
  const townCandidates = parsed.town
    ? await candidateStreetNamesInTown(db, parsed.streetName, parsed.town, parsed.state)
    : [];
  const zipCandidates = await candidateStreetNames(db, parsed.streetName, {
    zip: parsed.zip,
    state: parsed.state,
  });
  const seen = new Set();
  const candidates = [...townCandidates, ...zipCandidates]
    .filter((c) => {
      const key = `${c.fullname}|${c.zipl}|${c.zipr}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) return null;

  if (runBudget && runBudget.remaining <= 0) return null;
  const dailyCap = context === 'batch' ? MAX_BATCH_ASSISTS_PER_ACCOUNT_PER_DAY : MAX_ASSISTS_PER_ACCOUNT_PER_DAY;
  const { rows: usageRows } = await usersDb.query(
    `SELECT count(*)::int AS n FROM llm_geocode_assists
     WHERE email = $1 AND context = $2 AND created_at > now() - interval '1 day'`,
    [email, context]
  );
  if (usageRows[0].n >= dailyCap) return null;
  // Spent the moment the LLM is actually called, whatever it answers.
  // Re-checked here, with no await between check and spend: batch runs
  // several rows at once, and they'd all pass the check above while
  // waiting on the query, then overspend the run's budget together.
  if (runBudget) {
    if (runBudget.remaining <= 0) return null;
    runBudget.remaining -= 1;
  }

  const { picked, failureReason } = await pickCandidateWithLlm(originalInput, candidates);

  if (!picked) {
    await logLlmGeocodeAssist(usersDb, {
      email,
      originalInput,
      candidates,
      picked: null,
      succeeded: false,
      failureReason,
      context,
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
  if (picked.inNamedTown) {
    // Found inside the named town, so re-match it there (the address's
    // ZIP may be the very thing that's wrong).
    ({ result } = await matchByStreetAndTown(
      db,
      parsed.number,
      picked.fullname,
      parsed.town,
      parsed.state,
      parsed.zip,
      offsetFeet
    ));
  }
  for (const zip of result ? [] : zipsToTry) {
    try {
      result = await matchByStreetAndZip(db, parsed.number, picked.fullname, zip, parsed.state, offsetFeet);
      break;
    } catch {
      // Try the next ZIP; if none works, the failure is logged just below.
    }
  }
  if (result && !(await correctionFitsNamedTown(db, parsed.town, result.coordinates))) {
    await logLlmGeocodeAssist(usersDb, {
      email,
      originalInput,
      candidates,
      picked: correctedAddress,
      succeeded: false,
      failureReason: 'town_mismatch',
      context,
    });
    return null;
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
      context,
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
    context,
  });

  return {
    ...result,
    source: 'llm_assisted',
    originalInput,
    correctedAddress,
    // Just the street name the LLM picked (correctedAddress also carries
    // its ZIP/state), for showing "read as ..." next to a result.
    correctedStreet: picked.fullname,
  };
}

module.exports = {
  attemptLlmAssist,
  batchLlmAssist,
  MAX_ASSISTS_PER_ACCOUNT_PER_DAY,
  MAX_BATCH_ASSISTS_PER_ACCOUNT_PER_DAY,
  MAX_ASSISTS_PER_BATCH_RUN,
};
