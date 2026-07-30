const { ValidationError } = require('./errors');

const MAX_ADDRESS_LENGTH = 200;

/**
 * Parses a free-text address into { number, streetName, zip }.
 *
 * Handles the common shapes:
 *   "996 Pequawket Trl, Standish, ME 04091"
 *   "996 Pequawket Trl ME 04091"
 * Basic by design: assumes a leading house number and a trailing
 * 5-digit ZIP, and takes everything between them (up to the first
 * comma, if any, and stripping a trailing 2-letter state code) as the
 * street name.
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

  const commaIndex = afterNumber.indexOf(',');
  let streetPart = commaIndex >= 0 ? afterNumber.slice(0, commaIndex) : afterNumber;

  // If there was no comma, strip the ZIP itself and a trailing state code
  // (e.g. "Pequawket Trl ME 04091" -> "Pequawket Trl").
  if (commaIndex < 0) {
    const zipIndexInStreetPart = streetPart.lastIndexOf(zip);
    if (zipIndexInStreetPart >= 0) {
      streetPart = streetPart.slice(0, zipIndexInStreetPart);
    }
    streetPart = streetPart.replace(/\s+[A-Za-z]{2}\s*$/, '');
  }

  streetPart = streetPart.trim().replace(/\s+/g, ' ');
  if (!streetPart) {
    throw new ValidationError('address must include a street name');
  }

  return { number, streetName: streetPart, zip };
}

module.exports = { parseAddress };
