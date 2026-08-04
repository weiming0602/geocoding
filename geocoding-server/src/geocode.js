const { parseAddress } = require('./parseAddress');
const { parseLinestring, interpolateAlongLine } = require('./interpolate');
const { expandStreetSuffix } = require('./streetSuffixes');
const { NotFoundError, OutOfRangeError } = require('./errors');

/**
 * Finds every streets row known by `streetName` — checking not just its
 * primary fullname but every alternate name TIGER records for that TLID
 * in street_names (e.g. "Pequawket Trl" and "State Rte 113" can be the
 * same physical segment) — matching the given side's ZIP (zipl for odd
 * house numbers, zipr for even — TIGER edges can have a different ZIP on
 * each side of the same segment), and (if provided) state. A 2-letter
 * state is matched against state_abbr; anything else against the full
 * state name. A single named street is typically split into many `edges`
 * segments, each covering a different address sub-range, so callers must
 * pick the segment whose range actually contains the target number.
 */
async function candidateStreets(db, streetName, zip, zipColumn, state) {
  if (zipColumn !== 'zipl' && zipColumn !== 'zipr') {
    throw new Error(`zipColumn must be 'zipl' or 'zipr', got ${zipColumn}`);
  }
  const stateColumn = state && state.length === 2 ? 'state_abbr' : 'state';
  const stateClause = state ? `AND UPPER(street_names.${stateColumn}) = UPPER($3)` : '';
  const stateParam = state ? [state] : [];

  // Driving the query from street_names (filtered by its own
  // UPPER(fullname)+zip+state composite index) rather than from streets
  // matters: street_names carries denormalized copies of zipl/zipr/state
  // for exactly this reason (see schema.py). Filtering streets first and
  // joining to street_names per matched row turns into a per-row nested
  // lookup for every segment in the ZIP -- measured ~15x slower at batch
  // scale. Filtering street_names first hits its composite index directly
  // and only touches streets (via its unique tlid index) for the few rows
  // that actually match.
  const buildQuery = (nameClause) => `
    SELECT DISTINCT streets.* FROM street_names
    JOIN streets ON streets.tlid = street_names.tlid
    WHERE ${nameClause} AND street_names.${zipColumn} = $2 ${stateClause}
  `;

  const exact = await db.query(buildQuery('UPPER(street_names.fullname) = UPPER($1)'), [
    streetName,
    zip,
    ...stateParam,
  ]);
  if (exact.rows.length > 0) return exact.rows;

  const fallback = await db.query(buildQuery('UPPER(street_names.fullname) LIKE UPPER($1)'), [
    `%${streetName}%`,
    zip,
    ...stateParam,
  ]);
  return fallback.rows;
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
 */
async function matchAddressPoint(db, number, streetName, town) {
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

  if (rows.length === 1) return rows[0];
  return null; // no match, or ambiguous across towns with no town given
}

/**
 * Resolves a free-text address to coordinates using the local `streets`
 * table: odd house numbers interpolate against the left range
 * (lfromadd/ltoadd), match on zipl, and are offset left of the
 * centerline; even house numbers use the right range (rfromadd/rtoadd),
 * match on zipr, and are offset right.
 */
async function geocode(db, addressInput, { offsetFeet = 20 } = {}) {
  const { number, streetName, zip, state, town } = parseAddress(addressInput);

  const addressPoint = await matchAddressPoint(db, number, streetName, town);
  if (addressPoint) {
    return {
      input: { number, streetName, zip, state, town },
      match: {
        siteUid: addressPoint.site_uid,
        fullname: addressPoint.street_fullname,
        town: addressPoint.town,
        county: addressPoint.county,
        state_abbr: addressPoint.state_abbr,
      },
      source: 'address_point',
      coordinates: { latitude: addressPoint.latitude, longitude: addressPoint.longitude },
    };
  }

  const rangeSide = number % 2 === 1 ? 'left' : 'right';
  const offsetSide = rangeSide;
  const [fromCol, toCol] = rangeSide === 'left' ? ['lfromadd', 'ltoadd'] : ['rfromadd', 'rtoadd'];
  const zipColumn = rangeSide === 'left' ? 'zipl' : 'zipr';

  const candidates = await candidateStreets(db, streetName, zip, zipColumn, state);
  if (candidates.length === 0) {
    const stateSuffix = state ? ` (state ${state})` : '';
    throw new NotFoundError(`no street found matching "${streetName}" in ZIP ${zip}${stateSuffix}`);
  }

  let matchedRow = null;
  let fraction = null;
  for (const row of candidates) {
    const fromRaw = row[fromCol];
    const toRaw = row[toCol];
    if (!fromRaw || !toRaw) continue;
    const fromNum = parseInt(fromRaw, 10);
    const toNum = parseInt(toRaw, 10);
    const lo = Math.min(fromNum, toNum);
    const hi = Math.max(fromNum, toNum);
    if (number >= lo && number <= hi) {
      matchedRow = row;
      fraction = (number - fromNum) / (toNum - fromNum);
      break;
    }
  }

  if (!matchedRow) {
    throw new OutOfRangeError(
      `no "${streetName}" segment in ZIP ${zip} has a ${rangeSide} range containing ${number} ` +
        `(${candidates.length} segment(s) found for this street/ZIP, none cover that number)`
    );
  }

  const points = parseLinestring(matchedRow.geometry);
  const [longitude, latitude] = interpolateAlongLine(points, fraction, offsetFeet, offsetSide);

  const match = {
    id: matchedRow.id,
    tlid: matchedRow.tlid,
    fullname: matchedRow.fullname,
    zipl: matchedRow.zipl,
    zipr: matchedRow.zipr,
  };
  if (state) {
    if (state.length === 2) {
      match.state_abbr = matchedRow.state_abbr;
    } else {
      match.state = matchedRow.state;
    }
  }

  return {
    input: { number, streetName, zip, state, town },
    match,
    source: 'interpolation',
    rangeSide,
    offsetSide,
    offsetFeet,
    coordinates: { latitude, longitude },
  };
}

module.exports = { geocode, candidateStreets, matchAddressPoint };
