// Pure logic shared by both frontends' Import Addresses feature (upload
// a CSV/Excel export, map which column is which, build a clean address
// line per row). Kept dependency-free like parseCoordinateInput.ts so
// it works identically in a browser (ui/desktop) and React Native
// (ui/mobile) -- neither the column-mapping guesses nor the address-
// line format should ever drift between the two.

export type ColumnRole = 'ignore' | 'id' | 'streetFull' | 'streetNumber' | 'streetName' | 'city' | 'state' | 'zip';

export const ROLE_OPTIONS: { value: ColumnRole; label: string }[] = [
  { value: 'ignore', label: 'Ignore this column' },
  { value: 'id', label: 'Primary key / ID' },
  { value: 'streetFull', label: 'Street (number + name together)' },
  { value: 'streetNumber', label: 'Street number' },
  { value: 'streetName', label: 'Street name' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'zip', label: 'ZIP code' },
];

// Best-guess mapping from a header cell's text -- the user confirms or
// fixes this on the mapping step, so a wrong guess costs one tap/click,
// not a bad import. Order matters: id and streetNumber's patterns are
// checked before the broader streetFull/streetName ones so e.g. "Record
// ID" or "Street Number" don't fall through to a looser later match.
export function guessRole(header: string): ColumnRole {
  const h = header.toLowerCase().trim();
  if (/^(id|record.?id|customer.?id|primary.?key|uu?id|ref(erence)?(.?(id|no\.?|num(ber)?))?)$/.test(h)) return 'id';
  if (/house\s*(no\.?|number)\b|street\s*(no\.?|number)\b|addr.*num|^(no|num|number)$/.test(h)) return 'streetNumber';
  if (/full.*addr|^address$|^address ?1$|street.*addr|property.*addr|site.*addr|situs.*addr|mailing.*addr|^addr\.?$/.test(h)) return 'streetFull';
  if (/street.*name|^street$|^road$/.test(h)) return 'streetName';
  if (/city|town/.test(h)) return 'city';
  if (/state|province/.test(h)) return 'state';
  if (/zip|postal/.test(h)) return 'zip';
  return 'ignore';
}

// Shared by buildAddressLine (to assemble the address line) and each
// app's preview-step column filters (to list a mapped column's distinct
// values) -- one lookup, so both agree on which column a role points at.
export function getMappedValue(row: string[], mapping: Record<number, ColumnRole>, role: ColumnRole): string {
  const idx = Object.keys(mapping).find((i) => mapping[Number(i)] === role);
  return idx !== undefined ? (row[Number(idx)] ?? '').toString().trim() : '';
}

// Mirrors placesSearch.js's addressLineFromTags shape server-side:
// "<street>, <city>, <state> <zip>" with city/state omitted gracefully
// when blank -- kept in sync so imported rows and Overpass-found places
// produce the same address-line format.
export function buildAddressLine(row: string[], mapping: Record<number, ColumnRole>): string {
  const get = (role: ColumnRole) => getMappedValue(row, mapping, role);
  let street = get('streetFull');
  if (!street) {
    street = [get('streetNumber'), get('streetName')].filter(Boolean).join(' ');
  }
  const city = get('city');
  const state = get('state');
  const zip = get('zip');
  const cityState = [city, state].filter(Boolean).join(', ');
  const middle = cityState ? `, ${cityState}` : '';
  return `${street}${middle}${zip ? ` ${zip}` : ''}`.replace(/\s+/g, ' ').trim();
}

// Same leading-number / trailing-5-digit-ZIP rule geocoding-server's
// parseAddress.js enforces -- flagging it here means a row that won't
// geocode gets caught before download/send, not after a wasted Batch run.
export function isGeocodableAddressLine(line: string): boolean {
  return Boolean(line) && line.length <= 200 && /^\d+\b/.test(line) && /\b\d{5}\b/.test(line);
}
