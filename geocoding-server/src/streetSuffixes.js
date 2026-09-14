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

// The reverse of SUFFIX_EXPANSIONS, keyed by the lowercased full name --
// e.g. 'circle' -> 'Cir'. Built once at module load, not per call.
const SUFFIX_ABBREVIATIONS = Object.fromEntries(
  Object.entries(SUFFIX_EXPANSIONS).map(([abbr, full]) => [
    full.toLowerCase(),
    abbr.charAt(0).toUpperCase() + abbr.slice(1),
  ])
);

/** Abbreviates a trailing spelled-out street suffix (e.g. "Pequawket
 * Trail" -> "Pequawket Trl") -- the reverse of expandStreetSuffix, needed
 * because TIGER's own street_names.fullname always stores the
 * abbreviated form (unlike Maine's E911 address_points, which spells it
 * out), so a caller who types the suffix in full would otherwise never
 * match it there. Returns the input unchanged if its last word isn't a
 * known full suffix name (including when it's already abbreviated). */
function abbreviateStreetSuffix(streetName) {
  const words = streetName.split(' ');
  const last = words[words.length - 1].replace(/\.$/, '').toLowerCase();
  const abbreviation = SUFFIX_ABBREVIATIONS[last];
  if (!abbreviation) return streetName;
  return [...words.slice(0, -1), abbreviation].join(' ');
}

module.exports = { expandStreetSuffix, abbreviateStreetSuffix };
