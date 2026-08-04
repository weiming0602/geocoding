// TIGER/USPS addresses abbreviate street suffixes ("Dr", "St", "Rd");
// Maine's E911 address points spell them out in full ("Drive", "Street",
// "Road") per NENA convention. address_points won't exact-match a TIGER-
// style input without expanding the suffix first. Common USPS Pub. 28
// abbreviations only -- covers the vast majority of real addresses, not
// meant to be exhaustive.
const SUFFIX_EXPANSIONS = {
  ave: 'Avenue',
  blvd: 'Boulevard',
  cir: 'Circle',
  ct: 'Court',
  dr: 'Drive',
  hwy: 'Highway',
  ln: 'Lane',
  pkwy: 'Parkway',
  pl: 'Place',
  plz: 'Plaza',
  rd: 'Road',
  sq: 'Square',
  st: 'Street',
  ter: 'Terrace',
  trl: 'Trail',
  way: 'Way',
};

/** Expands a trailing abbreviated street suffix (e.g. "Deerfield Dr" ->
 * "Deerfield Drive"). Returns the input unchanged if its last word isn't
 * a known abbreviation (including when it's already spelled out). */
function expandStreetSuffix(streetName) {
  const words = streetName.split(' ');
  const last = words[words.length - 1].replace(/\.$/, '').toLowerCase();
  const expansion = SUFFIX_EXPANSIONS[last];
  if (!expansion) return streetName;
  return [...words.slice(0, -1), expansion].join(' ');
}

module.exports = { expandStreetSuffix };
