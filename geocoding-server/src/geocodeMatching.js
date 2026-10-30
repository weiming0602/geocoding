const { parseLinestring, interpolateAlongLine, metersPerDegree } = require('./interpolate');
const { expandStreetSuffix, abbreviateStreetSuffix } = require('./streetSuffixes');
const { NotFoundError, OutOfRangeError } = require('./errors');

/**
 * Finds every streets row known by `streetName` — checking not just its
 * primary fullname but every alternate name TIGER records for that TLID
 * in street_names (e.g. "Pequawket Trl" and "State Rte 113" can be the
 * same physical segment) — with `zip` on EITHER side (zipl or zipr --
 * TIGER edges can have a different ZIP on each side of the same
 * segment, and which side holds a given house number isn't known until
 * matchByStreetAndZip checks each side's range), and (if provided)
 * state. A 2-letter
 * state is matched against state_abbr; anything else against the full
 * state name. A single named street is typically split into many `edges`
 * segments, each covering a different address sub-range, so callers must
 * pick the segment whose range actually contains the target number.
 *
 * Also tries `streetName` with its suffix abbreviated (e.g. "Pequawket
 * Trail" -> "Pequawket Trl") alongside the name as given: TIGER's own
 * street_names.fullname always stores the abbreviated form, unlike Maine's
 * E911 address_points (which matchAddressPoint already handles both
 * directions for), so a caller who spells the suffix out in full would
 * otherwise never match here at all. abbreviateStreetSuffix is a no-op
 * when the input isn't a recognized full suffix name (including when
 * it's already abbreviated), so trying both is always safe.
 */
async function candidateStreets(db, streetName, zip, state) {
  const stateColumn = state && state.length === 2 ? 'state_abbr' : 'state';
  const stateClause = state ? `AND UPPER(street_names.${stateColumn}) = UPPER($4)` : '';
  const stateParam = state ? [state] : [];
  const abbreviated = abbreviateStreetSuffix(streetName);

  // Driving the query from street_names (filtered by its own
  // UPPER(fullname)+zip+state composite index) rather than from streets
  // matters: street_names carries denormalized copies of zipl/zipr/state
  // for exactly this reason (see schema.py). Filtering streets first and
  // joining to street_names per matched row turns into a per-row nested
  // lookup for every segment in the ZIP -- measured ~15x slower at batch
  // scale. Filtering street_names first hits its composite index directly
  // and only touches streets (via its unique tlid index) for the few rows
  // that actually match.
  //
  // One query per ZIP column (each hits its own composite index) rather
  // than a single `zipl = $3 OR zipr = $3`, merged by id. Exact names are
  // tried on BOTH sides before the LIKE fallback runs on either, so an
  // exact "Grove St" on one side can't be outvoted by a LIKE match like
  // "Grove St Exd" on the other.
  const buildQuery = (nameClause, zipColumn) => `
    SELECT DISTINCT streets.* FROM street_names
    JOIN streets ON streets.tlid = street_names.tlid
    WHERE ${nameClause} AND street_names.${zipColumn} = $3 ${stateClause}
  `;
  const bothSides = async (nameClause, params) => {
    const byId = new Map();
    for (const zipColumn of ['zipl', 'zipr']) {
      const { rows } = await db.query(buildQuery(nameClause, zipColumn), params);
      for (const row of rows) byId.set(String(row.id), row);
    }
    return [...byId.values()];
  };

  const exact = await bothSides('UPPER(street_names.fullname) IN (UPPER($1), UPPER($2))', [
    streetName,
    abbreviated,
    zip,
    ...stateParam,
  ]);
  if (exact.length > 0) return exact;

  return bothSides(
    '(UPPER(street_names.fullname) LIKE UPPER($1) OR UPPER(street_names.fullname) LIKE UPPER($2))',
    [`%${streetName}%`, `%${abbreviated}%`, zip, ...stateParam]
  );
}

/**
 * Prototype: looks for an exact real-world location in Maine's E911
 * address_points table (see ingest_address_points.py) before ever
 * falling back to range-interpolation. Where a point exists, it's simply
 * more accurate -- range-interpolation assumes house numbers are evenly
 * spaced along a segment, which is often false on long rural roads with
 * a handful of widely-spaced houses.
 *
 * address_points is keyed by town, not ZIP (that's what Maine's E911
 * data carries; ZIP is a TIGER/USPS concept, not a NENA one), so this
 * matches on street name + house number, narrowed by town when the
 * caller's address included one (see parseAddress.js). Without a town,
 * multiple same-named-street-and-number matches across different towns
 * can't be disambiguated safely, so an ambiguous no-town match is
 * treated as no match at all rather than guessing.
 *
 * A 2-letter state, when given, is checked directly against the
 * matched point's own state_abbr. ZIP has no column on address_points
 * to check directly -- instead it's cross-checked against street_names'
 * zipl/zipr for this street name (the same TIGER data candidateStreets
 * uses below), but only when TIGER actually has an opinion: if this
 * street name has no street_names entry at all (real for streets E911
 * covers that TIGER doesn't -- see the "Test Point Lane" fixture in
 * test/helpers.js), there's nothing to contradict the caller's ZIP with,
 * so it's left unchecked rather than rejecting a match TIGER simply
 * has no data on. When street_names *does* have this street under a
 * completely different set of ZIPs, that's real contradicting evidence
 * (a typo, or the same street name in a different town) -- the match is
 * treated as no match instead of accepted with full confidence, falling
 * through to the interpolation path, which does validate ZIP directly.
 */
async function matchAddressPoint(db, number, streetName, town, zip, state) {
  // TIGER-style input abbreviates suffixes ("Dr"); Maine's E911 data
  // spells them out ("Drive") -- try both so neither style is required.
  const expanded = expandStreetSuffix(streetName);
  const townClause = town ? 'AND UPPER(town) = UPPER($4)' : '';
  const params = town ? [streetName, expanded, number, town] : [streetName, expanded, number];

  const { rows } = await db.query(
    `SELECT id, site_uid, street_fullname, town, county, state_abbr, ST_X(geom) AS longitude, ST_Y(geom) AS latitude
     FROM address_points
     WHERE UPPER(street_fullname) IN (UPPER($1), UPPER($2)) AND address_number = $3 ${townClause}`,
    params
  );

  if (rows.length !== 1) return null; // no match, or ambiguous across towns with no town given
  const point = rows[0];

  if (state && state.length === 2 && point.state_abbr && point.state_abbr.toUpperCase() !== state.toUpperCase()) {
    return null;
  }

  if (zip) {
    const { rows: zipCheckRows } = await db.query(
      `SELECT
         count(*) > 0 AS street_known,
         count(*) FILTER (WHERE zipl = $3 OR zipr = $3) > 0 AS zip_matches
       FROM street_names
       WHERE UPPER(fullname) IN (UPPER($1), UPPER($2))`,
      [streetName, expanded, zip]
    );
    const { street_known, zip_matches } = zipCheckRows[0];
    if (street_known && !zip_matches) return null;
  }

  return point;
}

const SIDES = {
  left: { fromCol: 'lfromadd', toCol: 'ltoadd', zipCol: 'zipl' },
  right: { fromCol: 'rfromadd', toCol: 'rtoadd', zipCol: 'zipr' },
};

/** The `match` part of a result, for a matched streets row. */
function describeMatch(row, state) {
  const match = { id: row.id, tlid: row.tlid, fullname: row.fullname, zipl: row.zipl, zipr: row.zipr };
  if (state) {
    if (state.length === 2) {
      match.state_abbr = row.state_abbr;
    } else {
      match.state = row.state;
    }
  }
  return match;
}

/**
 * If `row`'s `side` can hold house `number` in ZIP `zip`, returns the
 * interpolation fraction along that side's range; otherwise null. A side
 * qualifies when its own ZIP is `zip` (any ZIP when `zip` is null -- a
 * match by town, see matchByStreetAndTown), its range contains `number`, and
 * the range holds numbers of the same parity -- which side carries odd
 * vs. even numbers is NOT fixed in TIGER (left/right just follow the
 * direction each line happens to be digitized in; about 57% of Maine/NH
 * segments carry odd numbers on the right). A side whose own from/to
 * parities differ (~0.015% of real sides) is accepted on range alone,
 * since it makes no parity claim to check against.
 */
function sideFraction(row, side, number, zip) {
  const { fromCol, toCol, zipCol } = SIDES[side];
  if (zip !== null && row[zipCol] !== zip) return null;
  const fromNum = parseInt(row[fromCol], 10);
  const toNum = parseInt(row[toCol], 10);
  if (Number.isNaN(fromNum) || Number.isNaN(toNum)) return null;
  if (number < Math.min(fromNum, toNum) || number > Math.max(fromNum, toNum)) return null;
  const sideIsMixedParity = fromNum % 2 !== toNum % 2;
  if (!sideIsMixedParity && fromNum % 2 !== number % 2) return null;
  return fromNum === toNum ? 0 : (number - fromNum) / (toNum - fromNum);
}

// A house number no segment's range covers, but which sits in a small hole
// between two ranges on the same street (see rangeGapFallback): at most
// this many house numbers wide...
const MAX_RANGE_GAP_NUMBERS = 50;
// ...and with the two ranges' facing ends physically this close, so it's
// a hole in the numbering, not two unrelated stretches of the street.
const MAX_RANGE_GAP_METERS = 150;

/** The numbered range on `row`'s `side` usable for `number` in `zip` (any ZIP if null), or null. */
function sideRange(row, side, number, zip) {
  const { fromCol, toCol, zipCol } = SIDES[side];
  if (zip !== null && row[zipCol] !== zip) return null;
  const from = parseInt(row[fromCol], 10);
  const to = parseInt(row[toCol], 10);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const mixedParity = from % 2 !== to % 2;
  if (!mixedParity && from % 2 !== number % 2) return null;
  return { row, side, from, to, low: Math.min(from, to), high: Math.max(from, to) };
}

/** Where `value` (one of the range's two ends) lies on the street, offset to its side. */
function rangeEndPoint(range, value, offsetFeet) {
  const fraction = range.from === range.to ? 0 : (value - range.from) / (range.to - range.from);
  return interpolateAlongLine(parseLinestring(range.row.geometry), fraction, offsetFeet, range.side);
}

/**
 * For a house number in a gap between two segments' ranges -- TIGER often
 * leaves small holes: Exeter NH's High St runs odd 29-31 on one segment
 * and 37-53 on the next, so 33 and 35 matched nothing -- places it
 * between the facing ends of the nearest range below and the nearest
 * above, on the same street, ZIP and side numbering. Only for a real
 * hole: both neighbours must exist (a number past the street's last
 * address still fails), the gap must be small, and the two ends close
 * together. Returns { range, coordinates } (range: the nearer neighbour)
 * or null.
 */
function rangeGapFallback(candidates, number, zip, offsetFeet) {
  let below = null;
  let above = null;
  for (const row of candidates) {
    for (const side of ['left', 'right']) {
      const range = sideRange(row, side, number, zip);
      if (!range) continue;
      if (range.high < number && (!below || range.high > below.high)) below = range;
      if (range.low > number && (!above || range.low < above.low)) above = range;
    }
  }
  if (!below || !above || above.low - below.high > MAX_RANGE_GAP_NUMBERS) return null;
  // Each end is offset by its own segment's side: left/right follow the
  // direction each segment happens to be digitized in, so the same side
  // of the road can be "left" on one segment and "right" on the next --
  // both ends still land on the side holding this number's parity.

  const [lon1, lat1] = rangeEndPoint(below, below.high, offsetFeet);
  const [lon2, lat2] = rangeEndPoint(above, above.low, offsetFeet);
  const [mPerDegLon, mPerDegLat] = metersPerDegree((lat1 + lat2) / 2);
  if (Math.hypot((lon2 - lon1) * mPerDegLon, (lat2 - lat1) * mPerDegLat) > MAX_RANGE_GAP_METERS) return null;

  const t = (number - below.high) / (above.low - below.high);
  return {
    range: number - below.high <= above.low - number ? below : above,
    coordinates: { latitude: lat1 + (lat2 - lat1) * t, longitude: lon1 + (lon2 - lon1) * t },
  };
}

/**
 * Finishes a geocode once a street name + ZIP are known to be correct —
 * either the caller's own parsed input (geocode.js's normal path), or an
 * LLM-corrected candidate pulled from real street_names data
 * (llmAssist.js's retry path). Shared by both so the range/interpolation
 * math exists in exactly one place. Extracted verbatim from geocode()'s
 * own body — behavior is unchanged from before this extraction.
 */
async function matchByStreetAndZip(db, number, streetName, zip, state, offsetFeet) {
  const candidates = await candidateStreets(db, streetName, zip, state);
  if (candidates.length === 0) {
    const stateSuffix = state ? ` (state ${state})` : '';
    throw new NotFoundError(`no street found matching "${streetName}" in ZIP ${zip}${stateSuffix}`);
  }
  return matchAmongCandidates(candidates, number, streetName, zip, state, offsetFeet);
}

/**
 * Picks the segment among `candidates` (all one street) whose range holds
 * `number`, and interpolates the point. `zip` restricts which sides count
 * (null: any side's ZIP, for a match by town). Throws OutOfRangeError when
 * no range holds the number and no small gap between ranges does either.
 */
function matchAmongCandidates(candidates, number, streetName, zip, state, offsetFeet) {
  // The side a number's parity "usually" lands on is only a tie-breaker,
  // for the rare segment (~315 in Maine/NH) whose two sides carry the
  // same parity -- see sideFraction for why it can't be the rule itself.
  const sideOrder = number % 2 === 1 ? ['left', 'right'] : ['right', 'left'];
  let matchedRow = null;
  let fraction = null;
  let rangeSide = null;
  for (const row of candidates) {
    for (const side of sideOrder) {
      const sideMatch = sideFraction(row, side, number, zip);
      if (sideMatch !== null) {
        matchedRow = row;
        fraction = sideMatch;
        rangeSide = side;
        break;
      }
    }
    if (matchedRow) break;
  }

  if (!matchedRow) {
    const gap = rangeGapFallback(candidates, number, zip, offsetFeet);
    if (gap) {
      return {
        match: describeMatch(gap.range.row, state),
        source: 'interpolation',
        rangeSide: gap.range.side,
        offsetSide: gap.range.side,
        offsetFeet,
        coordinates: gap.coordinates,
        // No segment's range holds this number; it was placed in the gap
        // between the two nearest ranges (see rangeGapFallback).
        approximate: true,
      };
    }
    const parity = number % 2 === 1 ? 'odd' : 'even';
    const where = zip !== null ? `in ZIP ${zip}` : `in ${candidates[0].town_name ?? 'that town'}`;
    throw new OutOfRangeError(
      `no "${streetName}" segment ${where} has a range of ${parity} numbers containing ${number} ` +
        `(${candidates.length} segment(s) found for this street there, none cover that number)`
    );
  }
  // The point goes on the same side of the centerline as the range that
  // actually holds this number.
  const offsetSide = rangeSide;

  const points = parseLinestring(matchedRow.geometry);
  const [longitude, latitude] = interpolateAlongLine(points, fraction, offsetFeet, offsetSide);

  return {
    match: describeMatch(matchedRow, state),
    source: 'interpolation',
    rangeSide,
    offsetSide,
    offsetFeet,
    coordinates: { latitude, longitude },
  };
}

// Postgres's "relation does not exist": a geocoding database whose towns
// table hasn't been loaded yet (see geocoding/ingest_towns.py). Town
// lookups then behave as if the town were unknown -- today's ZIP-only
// matching -- rather than failing every geocode that names a town.
const UNDEFINED_TABLE = '42P01';

async function queryTowns(db, sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return rows;
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

/** SQL restricting `towns` to `state` (2-letter or full name) as parameter $n, or '' with no state. */
function townStateClause(state, n) {
  if (!state) return '';
  return state.length === 2 ? `AND UPPER(towns.state_abbr) = UPPER($${n})` : `AND UPPER(towns.state) = UPPER($${n})`;
}

/**
 * Every streets row named `streetName` (exactly, or with its suffix
 * abbreviated -- no LIKE fallback, unlike candidateStreets: without a ZIP
 * to narrow it, a substring match would scan every street name in the
 * database, and the ZIP path that runs after this still has one) that
 * lies in a town called `town` -- by the segment's midpoint, so a
 * neighbouring town's segment merely touching the boundary (Westbrook's
 * Main St ends on Portland's line) doesn't count -- tagged with that town's geoid/name. Empty
 * when the town is unknown or has no such street; null when the towns
 * table doesn't exist.
 */
async function candidateStreetsInTown(db, streetName, town, state) {
  return queryTowns(
    db,
    `SELECT DISTINCT ON (streets.id, towns.geoid) streets.*, towns.geoid AS town_geoid, towns.name AS town_name
     FROM towns
     JOIN street_names ON UPPER(street_names.fullname) IN (UPPER($1), UPPER($2))
     JOIN streets ON streets.tlid = street_names.tlid
     WHERE UPPER(towns.name) = UPPER($3) ${townStateClause(state, 4)}
       AND towns.geom && streets.geom AND ST_Intersects(towns.geom, ST_LineInterpolatePoint(ST_GeometryN(streets.geom, 1), 0.5))`,
    [streetName, abbreviateStreetSuffix(streetName), town.trim(), ...(state ? [state] : [])]
  );
}

/**
 * Looks `streetName` up inside the town the address names, ignoring the
 * address's ZIP unless it helps: a wrong ZIP ("10 Forest Ave, Lebanon, NH
 * 03301" -- 03301 is Concord) otherwise sends the search to another town's
 * streets, either finding nothing or a same-named street 60 km away. Tried
 * before the ZIP (geocode.js); the ZIP is the fallback when the town is
 * unknown or doesn't have this street/number.
 *
 * Within a town, segments in the address's own ZIP are tried first (a town
 * can span several ZIPs), then any. Returns { result, error }: result is a
 * matchByStreetAndZip-shaped result plus matchedBy: 'town', match.town and
 * -- when the matched side's ZIP isn't the one given -- correctedZip; null
 * when the town can't place it. error is the OutOfRangeError when the
 * town has this street but no range holds the number, else null. Same-
 * named towns in more than one state (Lebanon ME / NH) with the street in
 * both and nothing to pick between them give no result.
 */
async function matchByStreetAndTown(db, number, streetName, town, state, zip, offsetFeet) {
  const candidates = await candidateStreetsInTown(db, streetName, town, state);
  if (!candidates || candidates.length === 0) return { result: null, error: null };

  const byTown = new Map();
  for (const row of candidates) {
    if (!byTown.has(row.town_geoid)) byTown.set(row.town_geoid, []);
    byTown.get(row.town_geoid).push(row);
  }

  const found = [];
  let error = null;
  for (const rows of byTown.values()) {
    for (const zipToTry of zip ? [zip, null] : [null]) {
      try {
        found.push({ rows, result: matchAmongCandidates(rows, number, streetName, zipToTry, state, offsetFeet) });
        break;
      } catch (err) {
        if (!(err instanceof OutOfRangeError)) throw err;
        error = err;
      }
    }
  }

  const withMatchedZip = found.map(({ rows, result }) => {
    const row = rows.find((r) => String(r.id) === String(result.match.id));
    return { rows, result, matchedZip: row[SIDES[result.rangeSide].zipCol] || null };
  });
  const sameZip = withMatchedZip.filter((f) => zip && f.matchedZip === zip);
  const chosen = withMatchedZip.length === 1 ? withMatchedZip[0] : sameZip.length === 1 ? sameZip[0] : null;
  if (!chosen) return { result: null, error: found.length > 0 ? null : error };

  const { rows, result, matchedZip } = chosen;
  return {
    result: {
      ...result,
      match: { ...result.match, town: rows[0].town_name },
      matchedBy: 'town',
      ...(zip && matchedZip && matchedZip !== zip ? { correctedZip: matchedZip } : {}),
    },
    error: null,
  };
}

const CANDIDATE_SIMILARITY_THRESHOLD = 0.3;
const MAX_CANDIDATES = 10;

/**
 * Finds real nearby street names by trigram spelling similarity, for
 * llmAssist.js to offer an LLM as pick-from candidates when the normal
 * exact/LIKE matching in candidateStreets() above found nothing. Scoped
 * as tightly as the input allows: by ZIP when given (strongest signal —
 * street_names has no town column, so ZIP is the closest we get to "the
 * same neighborhood"), else by state when given, else to ME/NH broadly
 * (this function is only ever called after isPlausiblyInCoverageArea()
 * has already confirmed the input belongs in that universe). Requires
 * the pg_trgm extension (CREATE EXTENSION IF NOT EXISTS pg_trgm) --
 * see geocoding/schema.py and this repo's CLAUDE.md for the one-time
 * manual setup step this needs on a real database.
 *
 * CANDIDATE_SIMILARITY_THRESHOLD (0.3) is a starting value, not
 * empirically tuned yet -- adjust once real misspelled-address examples
 * are available in production.
 *
 * No index accelerates this query -- a GIN trigram index only serves
 * the `%` similarity operator (or LIKE/ILIKE), not a bare
 * `similarity(...) > threshold` comparison like this one, and would
 * need to be built on UPPER(fullname) to match this query's casing
 * either way. A ZIP- or state-scoped call (the common case) still hits
 * the existing zipl/zipr or state indexes first and only computes
 * similarity() over that narrowed set; only the no-ZIP/no-state path
 * (geocode.js's own "no ZIP, no address-point match" branch) does a
 * full sequential scan of street_names (~475K rows, well under a
 * second) -- acceptable since that path is rare and already gated
 * behind isPlausiblyInCoverageArea and an authenticated-only check.
 */
async function candidateStreetNames(db, streetName, { zip, state } = {}) {
  const params = [streetName, CANDIDATE_SIMILARITY_THRESHOLD];
  let scopeClause;
  if (zip) {
    scopeClause = 'AND (zipl = $3 OR zipr = $3)';
    params.push(zip);
  } else if (state) {
    const stateColumn = state.length === 2 ? 'state_abbr' : 'state';
    scopeClause = `AND UPPER(${stateColumn}) = UPPER($3)`;
    params.push(state);
  } else {
    scopeClause = `AND UPPER(state_abbr) IN ('ME', 'NH')`;
  }

  const { rows } = await db.query(
    `SELECT DISTINCT fullname, zipl, zipr, state_abbr, similarity(UPPER(fullname), UPPER($1)) AS sim
     FROM street_names
     WHERE similarity(UPPER(fullname), UPPER($1)) > $2 ${scopeClause}
     ORDER BY sim DESC
     LIMIT ${MAX_CANDIDATES}`,
    params
  );
  return rows;
}

/**
 * candidateStreetNames, but scoped to the streets inside a named town
 * instead of a ZIP -- so a misspelled street with a wrong ZIP ("Furest
 * Ave, Lebanon, NH 03301") still gets the town's real "Forest Ave" as a
 * candidate. Rows are tagged inNamedTown so llmAssist re-matches a pick
 * by town, not by the (wrong) ZIP. Empty when the town is unknown or the
 * towns table doesn't exist.
 */
async function candidateStreetNamesInTown(db, streetName, town, state) {
  const rows = await queryTowns(
    db,
    `SELECT DISTINCT street_names.fullname, streets.zipl, streets.zipr, towns.state_abbr,
            similarity(UPPER(street_names.fullname), UPPER($1)) AS sim
     FROM towns
     JOIN streets ON towns.geom && streets.geom AND ST_Intersects(towns.geom, ST_LineInterpolatePoint(ST_GeometryN(streets.geom, 1), 0.5))
     JOIN street_names ON street_names.tlid = streets.tlid
     WHERE UPPER(towns.name) = UPPER($3) ${townStateClause(state, 4)}
       AND similarity(UPPER(street_names.fullname), UPPER($1)) > $2
     ORDER BY sim DESC
     LIMIT ${MAX_CANDIDATES}`,
    [streetName, CANDIDATE_SIMILARITY_THRESHOLD, town.trim(), ...(state ? [state] : [])]
  );
  return (rows ?? []).map((row) => ({ ...row, inNamedTown: true }));
}

module.exports = {
  candidateStreets,
  matchAddressPoint,
  matchByStreetAndZip,
  matchByStreetAndTown,
  candidateStreetNames,
  candidateStreetNamesInTown,
  queryTowns,
  MAX_CANDIDATES,
};
