const { parseAddress } = require('./parseAddress');
const { parseLinestring, interpolateAlongLine } = require('./interpolate');
const { NotFoundError, OutOfRangeError } = require('./errors');

/**
 * Finds every streets row matching fullname (case-insensitive), left ZIP,
 * and (if provided) state. A 2-letter state is matched against
 * state_abbr; anything else is matched against the full state name. A
 * single named street is typically split into many `edges` segments,
 * each covering a different address sub-range, so callers must pick the
 * segment whose range actually contains the target number.
 */
function candidateStreets(db, streetName, zip, state) {
  const stateColumn = state && state.length === 2 ? 'state_abbr' : 'state';
  const stateClause = state ? `AND UPPER(${stateColumn}) = UPPER(?)` : '';
  const stateParam = state ? [state] : [];

  const exact = db
    .prepare(`SELECT * FROM streets WHERE UPPER(fullname) = UPPER(?) AND zipl = ? ${stateClause}`)
    .all(streetName, zip, ...stateParam);
  if (exact.length > 0) return exact;

  return db
    .prepare(`SELECT * FROM streets WHERE UPPER(fullname) LIKE UPPER(?) AND zipl = ? ${stateClause}`)
    .all(`%${streetName}%`, zip, ...stateParam);
}

/**
 * Resolves a free-text address to coordinates using the local `streets`
 * table: odd house numbers interpolate against the left range
 * (lfromadd/ltoadd) and are offset left of the centerline; even house
 * numbers use the right range (rfromadd/rtoadd) and are offset right.
 */
function geocode(db, addressInput, { offsetFeet = 20 } = {}) {
  const { number, streetName, zip, state } = parseAddress(addressInput);

  const rangeSide = number % 2 === 1 ? 'left' : 'right';
  const offsetSide = rangeSide;
  const [fromCol, toCol] = rangeSide === 'left' ? ['lfromadd', 'ltoadd'] : ['rfromadd', 'rtoadd'];

  const candidates = candidateStreets(db, streetName, zip, state);
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

  return {
    input: { number, streetName, zip, state },
    match: {
      id: matchedRow.id,
      tlid: matchedRow.tlid,
      fullname: matchedRow.fullname,
      zipl: matchedRow.zipl,
      zipr: matchedRow.zipr,
    },
    rangeSide,
    offsetSide,
    offsetFeet,
    coordinates: { latitude, longitude },
  };
}

module.exports = { geocode, candidateStreets };
