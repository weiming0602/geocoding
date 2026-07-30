const { ValidationError } = require('./errors');

const MAX_ADDRESS_LENGTH = 200;

/**
 * Parses a free-text address into { number, streetName, zip, state }.
 *
 * Handles the common shapes:
 *   "996 Pequawket Trl, Standish, ME 04091"
 *   "996 Pequawket Trl, Standish, Maine 04091"
 *   "996 Pequawket Trl ME 04091"
 * Basic by design: assumes a leading house number and a trailing
 * 5-digit ZIP. Street name is everything up to the first comma (or,
 * with no comma, everything before the ZIP minus a trailing 2-letter
 * state code, if one is present). `state` is whatever sits between the
 * last comma and the ZIP — a 2-letter abbreviation or a full name — or
 * null if it can't be confidently isolated (e.g. no comma and no
 * trailing 2-letter code).
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

  const zipMatches = [...trimmed.matchAll(/\b\d{5}\b/g)].filter(
    (m) => m.index >= numberMatch[0].length
  );
  if (zipMatches.length === 0) {
    throw new ValidationError('address must include a 5-digit ZIP code');
  }
  const zip = zipMatches[zipMatches.length - 1][0];
  const zipIndexInAfterNumber = zipMatches[zipMatches.length - 1].index - numberMatch[0].length;
  const beforeZip = afterNumber.slice(0, zipIndexInAfterNumber);

  const commaIndex = beforeZip.indexOf(',');
  let streetPart;
  let state = null;

  if (commaIndex >= 0) {
    streetPart = beforeZip.slice(0, commaIndex);
    const lastCommaIndex = beforeZip.lastIndexOf(',');
    const stateCandidate = beforeZip.slice(lastCommaIndex + 1).trim();
    state = stateCandidate || null;
  } else {
    streetPart = beforeZip;
    const trailingStateMatch = /\s+([A-Za-z]{2})\s*$/.exec(streetPart);
    if (trailingStateMatch) {
      streetPart = streetPart.slice(0, trailingStateMatch.index);
      state = trailingStateMatch[1].toUpperCase();
    }
  }

  streetPart = streetPart.trim().replace(/\s+/g, ' ');
  if (!streetPart) {
    throw new ValidationError('address must include a street name');
  }

  return { number, streetName: streetPart, zip, state };
}

module.exports = { parseAddress };
