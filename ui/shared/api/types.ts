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

// GET /road-signals -- live traffic-hazard incidents near a point,
// sourced from New England 511 (Maine/NH/Vermont, see roadSignals.js and
// docs/ROAD_ALERTS_DESIGN.md). This is slice 1 of the Road Alerts design:
// traffic_hazard only, no weather/public_event types yet.
export type RoadSignalSeverity = 'serious' | 'need_to_know' | 'proximity' | 'fun_to_know';

export type RoadSignal = {
  id: string;
  type: 'traffic_hazard';
  source: string;
  network: string;
  status: string | null;
  roadway: string | null;
  direction: string | null;
  crossStreet: string | null;
  mileMarker: number | string | null;
  county: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  affectedLanes: string | null;
  affectedLanesDetail: string | null;
  weightRestriction: string | null;
  description: string | null;
  verifiedBy: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
  raw511Severity: string | null;
  raw511EventType: string | null;
  severity: RoadSignalSeverity;
  speech: { brief: string; average: string; deep: string };
};

export type RoadSignalsResponse = {
  signals: RoadSignal[];
  networks: string[];
  partial: boolean;
  failedNetworks: string[];
  generatedAt: string;
};

// POST /road-alerts/register -- idempotent: an already-registered email
// gets its existing service key back unchanged (alreadyRegistered: true),
// never a new key. Free for every registered account right now, no trial
// clock -- see geocoding-server/src/roadAlertsAccounts.js's
// registerAccount for why.
export type RoadAlertsRegisterResponse = {
  email: string;
  serviceKey: string;
  registeredAt: string;
  alreadyRegistered: boolean;
  serviceKeyEmailed: boolean;
  digestOptIn: boolean;
};

// GET/POST /road-alerts/preferences -- the account's opt-in flag for the
// daily email digest (see geocoding-server/src/roadAlertsDigest.js).
// Default false; only alerts explicitly saved via the voice
// "save"/"keep"/"email" command are ever included, never every alert
// spoken automatically.
export type RoadAlertsPreferencesResponse = {
  digestOptIn: boolean;
};

// /road-alerts/test/weighted-points -- fake, developer-seeded stand-ins
// for docs/ROAD_ALERTS_DESIGN.md's real (on-device, never server-side)
// routine subgraph, gated server-side behind ALLOW_TEST_WEIGHTED_POINTS
// and off by default. See geocoding-server/src/testWeightedPoints.js.
export type TestWeightedPoint = {
  id: number;
  email: string;
  latitude: number;
  longitude: number;
  weight: number;
  tlid: string | null;
  label: string | null;
  created_at: string;
};

export type TestWeightedPointsResponse = {
  weightedPoints: TestWeightedPoint[];
};

// POST /road-alerts/email-alert -- always sends to the authenticated
// account's own registered email (never an address the client names);
// `emailed: false, stubbed: true` when the server has no SES configured
// (see geocoding-server/src/emailDelivery.js's isSesConfigured), same as
// the service-key emails.
export type EmailRoadAlertResponse = {
  emailed: boolean;
  stubbed: boolean;
};
