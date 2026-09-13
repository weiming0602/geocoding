const { ValidationError } = require('./errors');

const MAX_ADDRESS_LENGTH = 200;

// Used to guard the no-comma trailing-2-letter-code heuristic below: many
// common street suffixes are also exactly 2 letters (Rd, St, Ln, Dr, Ct,
// Cv, Pl, Sq), so without this check "123 Main Rd 04001" would misparse
// as street="Main", state="RD". Requiring a real state/territory code
// eliminates every one of those false positives except "Ct" (Court vs.
// Connecticut), which is a genuine ambiguity no heuristic can resolve
// without a comma to disambiguate.
const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', 'GU', 'AS', 'MP',
]);

/**
 * Parses a free-text address into { number, streetName, zip, state, town }.
 *
 * Handles the common shapes:
 *   "996 Pequawket Trl, Standish, ME 04091"
 *   "996 Pequawket Trl, Standish, Maine 04091"
 *   "996 Pequawket Trl, Standish, Maine, 04091"
 *   "996 Pequawket Trl ME 04091"
 * Basic by design: assumes a leading house number. A trailing 5-digit
 * ZIP is used when present to anchor where the street/town/state portion
 * ends, but is not required -- `zip` comes back null when one isn't
 * found, and the rest of parsing runs on the whole remaining string
 * instead. Street name is everything up to the first comma (or, with no
 * comma, everything before the ZIP -- or the end of the string, with no
 * ZIP -- minus a trailing 2-letter state code, if one is present). `state`
 * is whatever sits between the last comma and the ZIP (or end of string)
 * — a 2-letter abbreviation or a full name — or null if it can't be
 * confidently isolated (e.g. no comma and no trailing 2-letter code).
 * `town` is whatever sits between the first and last comma (e.g.
 * "Standish" above) -- null when there's only one comma (or none), i.e.
 * no town was given separately from the street/state. A comma directly
 * before the ZIP with nothing after it (third example above) doesn't
 * count as its own segment -- without dropping it, "state" would end up
 * empty and "Standish, Maine" would incorrectly get swallowed whole into
 * `town`, since it'd otherwise look identical to "everything between the
 * first and last comma".
 * Used to match Maine's E911 address points, which are keyed by town
 * rather than ZIP (see matchAddressPoint in geocode.js) -- getting town
 * wrong here (e.g. "Standish, Maine" instead of "Standish") silently
 * falls back to interpolation instead of an exact match, since the E911
 * lookup requires an exact town match.
 */
function parseAddress(input) {
  if (typeof input !== 'string') {
    throw new ValidationError('address must be a string');
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new ValidationError('address must not be empty');
  }
  if (trimmed.length > MAX_ADDRESS_LENGTH) {
    throw new ValidationError(`address must be ${MAX_ADDRESS_LENGTH} characters or fewer`);
  }

  const numberMatch = /^(\d+)\b/.exec(trimmed);
  if (!numberMatch) {
    throw new ValidationError('address must start with a street number');
  }
  const number = parseInt(numberMatch[1], 10);
  const afterNumber = trimmed.slice(numberMatch[0].length);

  // A ZIP is used when present to anchor where the street/town/state
  // portion ends, but isn't required -- geocode.js's Maine E911
  // address-point path matches by town, not ZIP, so a caller who knows
  // the town doesn't need to also supply a ZIP. Without one, the
  // street/town/state parsing below just runs on the whole remaining
  // string instead of "everything before the ZIP" -- same logic either
  // way, since it never actually depended on the ZIP boundary itself.
  const zipMatches = [...trimmed.matchAll(/\b\d{5}\b/g)].filter(
    (m) => m.index >= numberMatch[0].length
  );
  const zip = zipMatches.length > 0 ? zipMatches[zipMatches.length - 1][0] : null;
  const beforeZip =
    zipMatches.length > 0
      ? afterNumber.slice(0, zipMatches[zipMatches.length - 1].index - numberMatch[0].length)
      : afterNumber;

  const commaIndices = [...beforeZip.matchAll(/,/g)].map((m) => m.index);
  let streetPart;
  let state = null;
  let town = null;

  if (commaIndices.length > 0) {
    streetPart = beforeZip.slice(0, commaIndices[0]);

    // With 3+ commas, a trailing one directly before the ZIP (nothing but
    // whitespace after it) is a separator, not its own segment -- drop it
    // so the real state segment (e.g. "Maine" in "..., Standish, Maine,
    // 04091") gets split out instead of absorbed into town. Only applies
    // past 2 commas: with exactly 2, that same "empty after the last
    // comma" shape is the normal "Street, Town, <zip>" case (no state
    // given at all), which already works via the empty-state fallback
    // below and must keep working unchanged.
    let usableCommaIndices = commaIndices;
    let stateSliceEnd = beforeZip.length;
    if (commaIndices.length > 2) {
      const trueLastComma = commaIndices[commaIndices.length - 1];
      if (!beforeZip.slice(trueLastComma + 1).trim()) {
        stateSliceEnd = trueLastComma;
        usableCommaIndices = commaIndices.slice(0, -1);
      }
    }

    const firstComma = usableCommaIndices[0];
    const lastComma = usableCommaIndices[usableCommaIndices.length - 1];
    const stateCandidate = beforeZip.slice(lastComma + 1, stateSliceEnd).trim();
    state = stateCandidate || null;
    if (lastComma > firstComma) {
      const townCandidate = beforeZip.slice(firstComma + 1, lastComma).trim();
      town = townCandidate || null;
    }
  } else {
    streetPart = beforeZip;
    const trailingStateMatch = /\s+([A-Za-z]{2})\s*$/.exec(streetPart);
    if (trailingStateMatch && US_STATE_CODES.has(trailingStateMatch[1].toUpperCase())) {
      streetPart = streetPart.slice(0, trailingStateMatch.index);
      state = trailingStateMatch[1].toUpperCase();
    }
  }

  streetPart = streetPart.trim().replace(/\s+/g, ' ');
  if (!streetPart) {
    throw new ValidationError('address must include a street name');
  }

  return { number, streetName: streetPart, zip, state, town };
}

module.exports = { parseAddress };
