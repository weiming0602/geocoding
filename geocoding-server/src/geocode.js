const { parseAddress } = require('./parseAddress');
const { NotFoundError } = require('./errors');
const { matchAddressPoint, matchByStreetAndZip } = require('./geocodeMatching');

/**
 * Resolves a free-text address to coordinates using the local `streets`
 * table: odd house numbers interpolate against the left range
 * (lfromadd/ltoadd), match on zipl, and are offset left of the
 * centerline; even house numbers use the right range (rfromadd/rtoadd),
 * match on zipr, and are offset right.
 */
async function geocode(db, addressInput, { offsetFeet = 20 } = {}) {
  const { number, streetName, zip, state, town } = parseAddress(addressInput);

  const addressPoint = await matchAddressPoint(db, number, streetName, town, zip, state);
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

  // No exact address-point match, and no ZIP to fall back on -- unlike
  // matchAddressPoint (keyed by town), candidateStreets has no town/city
  // column to filter by at all (TIGER's street_names only carries
  // zipl/zipr/state), so a common street name has no other way to be
  // disambiguated here. Caught explicitly, with a message naming the
  // actual problem, rather than letting `street_names.zipColumn = NULL`
  // silently match nothing and surface as a confusing "in ZIP null".
  if (!zip) {
    throw new NotFoundError(
      `could not find an exact address match for "${streetName}" in ${town ?? 'the given town'} -- ` +
        'add a ZIP code to search by street range instead'
    );
  }

  const result = await matchByStreetAndZip(db, number, streetName, zip, state, offsetFeet);
  return { input: { number, streetName, zip, state, town }, ...result };
}

module.exports = { geocode };
