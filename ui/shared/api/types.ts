// Response shapes for geocoding-server's actual endpoints (src/server.js).
// Kept here so ui/mobile and ui/desktop can't drift apart on field names --
// see e.g. the Meridian design handoff's original mixup of forward-geocode's
// `rangeSide`/`coordinates` with reverse-geocode's `side`/`matchedCoordinates`.

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type StreetMatch = {
  id: number;
  tlid?: string;
  fullname: string;
  zipl?: string;
  zipr?: string;
  state?: string;
  state_abbr?: string;
};

// A Maine E911 address point -- an exact match (see matchAddressPoint in
// geocode.js), preferred over interpolation whenever one exists. No
// rangeSide/offsetSide/offsetFeet: those describe *estimating* a point
// along a street segment, which doesn't apply when the point itself is
// already known exactly.
export type AddressPointMatch = {
  siteUid: string;
  fullname: string;
  town: string;
  county: string;
  state_abbr: string;
};

type GeocodeInput = { number: number; streetName: string; zip: string; state?: string; town?: string | null };

// POST /geocode -- a discriminated union (on `source`), not one shape
// with optional fields, because rangeSide/offsetSide/offsetFeet only
// exist for an interpolation match; an address_point match has none of
// them at all (see geocode.js). Rendering code must check `source`
// before assuming rangeSide exists -- ui/desktop's Geocode.tsx and
// Batch.tsx, and ui/mobile's GeocodeForm.tsx and BatchGeocodeForm.tsx,
// used to render an empty "side" tag for every address_point result
// because they didn't.
export type GeocodeResult =
  | {
      input: GeocodeInput;
      match: AddressPointMatch;
      source: 'address_point';
      coordinates: Coordinates;
    }
  | {
      input: GeocodeInput;
      match: StreetMatch;
      source: 'interpolation';
      rangeSide: 'left' | 'right';
      offsetSide: 'left' | 'right';
      offsetFeet: number;
      coordinates: Coordinates;
    };

// POST /reverse-geocode -- NOT the same shape as GeocodeResult: the side
// field is `side` here (not `rangeSide`), and the resolved point is
// `matchedCoordinates` (not `coordinates`).
export type ReverseGeocodeResult = {
  input: Coordinates;
  match: StreetMatch;
  side: 'left' | 'right';
  number: number | null;
  address: string;
  distanceMeters: number;
  matchedCoordinates: Coordinates;
};

// POST /geocode/batch, /geocode/batch/download -- each line's own
// success/failure, not one failure for the whole batch.
export type BatchResult =
  | ({ address: string; success: true } & GeocodeResult)
  | { address: string; success: false; error: string };

// usedThisPeriod/remaining/tier are omitted entirely (not just zero)
// when ALLOW_TEST_EMPTY_SERVICE_KEY is set server-side and the request
// carried no email -- a pure smoke test with no account/quota involved.
export type BatchGeocodeResponse = {
  results: BatchResult[];
  usedThisPeriod?: number;
  remaining?: number;
  tier?: number;
};

// What to send batch endpoints: a path the server can read off its own
// disk, or (added so a client with no server-reachable filesystem path --
// e.g. a phone, or a browser -- can upload a picked file's contents
// directly) raw file content. `email` and `serviceKey` are both required
// on all three batch endpoints (plain run, ZIP download, and
// email-delivery) -- quota is tracked and enforced against the pair the
// same way on all three. The key is issued once at purchase time (in
// POST /billing/purchase's response) and must be presented alongside
// the email on every batch request, so knowing an account's email alone
// isn't enough to spend its quota.
export type BatchSource = ({ filePath: string } | { fileContent: string }) & {
  email: string;
  serviceKey: string;
};

// GET /quota?email=...
export type QuotaStatus = {
  email: string;
  tier: number;
  usedThisPeriod: number;
  remaining: number;
  periodStart: string;
};

export type ApiErrorResponse = {
  error: string;
};

// POST /places/search -- free-text place search (via the public
// Overpass API, see placesSearch.js) near a point. `skipped` counts
// matched places that had a name/coordinate but not enough of a street
// address to produce a geocodable line; `truncated` is true when more
// results existed than the server's MAX_RESULTS cap.
export type PlaceResult = {
  name: string;
  address: string;
};

export type PlaceSearchResponse = {
  results: PlaceResult[];
  skipped: number;
  truncated: boolean;
  // Only set when the query included a "near <place>" clause (resolved
  // via Nominatim server-side) -- lets the caller show/update the map
  // to reflect where the search actually landed.
  center?: { latitude: number; longitude: number };
};
