const { parseAddress } = require('./parseAddress');
const { parseLinestring, interpolateAlongLine } = require('./interpolate');
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
function candidateStreets(db, streetName, zip, zipColumn, state) {
  if (zipColumn !== 'zipl' && zipColumn !== 'zipr') {
    throw new Error(`zipColumn must be 'zipl' or 'zipr', got ${zipColumn}`);
  }
  const stateColumn = state && state.length === 2 ? 'state_abbr' : 'state';
  const stateClause = state ? `AND UPPER(street_names.${stateColumn}) = UPPER(?)` : '';
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
    WHERE ${nameClause} AND street_names.${zipColumn} = ? ${stateClause}
  `;

  const exact = db
    .prepare(buildQuery('UPPER(street_names.fullname) = UPPER(?)'))
    .all(streetName, zip, ...stateParam);
  if (exact.length > 0) return exact;

  return db
    .prepare(buildQuery('UPPER(street_names.fullname) LIKE UPPER(?)'))
    .all(`%${streetName}%`, zip, ...stateParam);
}

/**
 * Resolves a free-text address to coordinates using the local `streets`
 * table: odd house numbers interpolate against the left range
 * (lfromadd/ltoadd), match on zipl, and are offset left of the
 * centerline; even house numbers use the right range (rfromadd/rtoadd),
 * match on zipr, and are offset right.
 */
function geocode(db, addressInput, { offsetFeet = 20 } = {}) {
  const { number, streetName, zip, state } = parseAddress(addressInput);

  const rangeSide = number % 2 === 1 ? 'left' : 'right';
  const offsetSide = rangeSide;
  const [fromCol, toCol] = rangeSide === 'left' ? ['lfromadd', 'ltoadd'] : ['rfromadd', 'rtoadd'];
  const zipColumn = rangeSide === 'left' ? 'zipl' : 'zipr';

  const candidates = candidateStreets(db, streetName, zip, zipColumn, state);
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
    input: { number, streetName, zip, state },
    match,
    rangeSide,
    offsetSide,
    offsetFeet,
    coordinates: { latitude, longitude },
  };
}

module.exports = { geocode, candidateStreets };
