# Add HERE Traffic API as a second Road Alerts hazard provider

**Status:** approved design, not yet implemented.
**Motivation:** Road Alerts hazard data (`geocoding-server/src/roadSignals.js`) currently
comes from exactly one source — New England 511, covering Maine/New Hampshire/Vermont
only. `docs/ROAD_ALERTS_DESIGN.md`'s "Texas coverage" section records a thorough search
for a free/public Texas equivalent that came up empty. HERE Technologies' Traffic API v7
was identified as a real, working paid alternative (30,000 free transactions/month, no
credit card) and verified live this session with a real API key against real locations —
see that section of `docs/ROAD_ALERTS_DESIGN.md` for the full research trail. This spec
covers integrating it as a second provider.

## Verified facts (not assumptions)

Tested live this session with a real HERE API key:

- Endpoint: `GET https://data.traffic.hereapi.com/v7/incidents?in=circle:{lat},{lon};r={radiusMeters}&locationReferencing=shape&apiKey={key}`
- **Correction made during plan-writing, re-verified live, not just from docs:** the
  original version of this spec used `locationReferencing=olr` (OpenLR), which only
  returns a binary-encoded location reference (base64 `olr` string) — decoding it into
  real coordinates needs a dedicated location-referencing library this project doesn't
  have. `shape` (Shape Points) was checked live instead and returns plain WGS84 `lat`/
  `lng` directly, no decoding needed — see `location.shape.links[].points[].{lat,lng}`
  below. Re-querying Dallas with `shape` returned 89 incidents (vs. 81 with `olr` for the
  same circle moments earlier — HERE's live incident set naturally shifts between calls,
  not a discrepancy between the two `locationReferencing` modes).
- Response shape:
  ```json
  {
    "sourceUpdated": "2026-09-10T11:41:27Z",
    "results": [{
      "location": {
        "length": 559.0,
        "shape": {
          "links": [
            { "points": [{ "lat": 32.81818, "lng": -96.84479 }, { "lat": 32.81947, "lng": -96.84636 }], "length": 206.0, "functionalClass": 3 },
            { "points": [{ "lat": 32.81947, "lng": -96.84636 }, { "lat": 32.81965, "lng": -96.84659 }], "length": 29.0, "functionalClass": 3 }
          ]
        }
      },
      "incidentDetails": {
        "id": "...", "hrn": "here:traffic:incident:...",
        "startTime": "...", "endTime": "...", "entryTime": "...",
        "roadClosed": false,
        "criticality": "minor" | "major" | "critical",
        "type": "construction" | "roadClosure" | "plannedEvent" | "laneRestriction" | "congestion" | "other" | ...,
        "typeDescription": { "value": "Road construction", "language": "en-US" },
        "description": { "value": "At W Mockingbird Ln - Construction work", "language": "en-US" },
        "summary": { "value": "Construction work", "language": "en-US" },
        "codes": [803, 500]
      }
    }]
  }
  ```
  A location's `shape` is a road segment (one or more `links`, each a polyline of
  `points`) rather than a single point — this app's `RoadSignal` shape needs one
  representative `latitude`/`longitude` per incident (for map markers and bbox
  filtering), so normalization takes the **first point of the first link**
  (`shape.links[0].points[0]`) as that incident's location. A location with no shape
  data at all (empty `links`) is defensively treated as having no coordinates, same as
  NE511's own `latitude`/`longitude: null` case.
  HERE's own documented `type` enum is likely broader than the ~6 values observed in our
  sample queries (Dallas TX: 81-89 incidents across two calls, Portland ME: 16 incidents)
  — the design below does not assume this list is exhaustive.
- Real, plausible data: street names (`I-35E/US-77/N Stemmons Fwy`, `Victory Ave`),
  sensible reasons (`closed due to major event` near several State-Fair-adjacent
  incidents in early September, matching the real Texas State Fair calendar).
- Free tier confirmed: 30,000 transactions/month, no credit card required to reach it.
- `criticality`/`roadClosed`/`type` are structured fields — unlike New England 511, which
  has no structured severity field at all and relies on keyword-matching free text
  (`mapSeverity`/`categorizeHazard` in `roadSignals.js`).

## Architecture

**Two files, geography decides which one runs — never both for the same request.**

- `roadSignals.js` stays exactly as it is today for New England 511 (`NE511_NETWORKS`,
  `fetchNetworkIncidentsCached`, `normalizeIncident`, `mapSeverity`, `categorizeHazard`,
  `boundingBoxDegrees`, `filterByBbox`, `sortByFreshness` — all already exported, all
  unchanged). Its own tests (`roadSignals.test.js`, `roadSignalsEndpoint.test.js`) are
  not touched.
- New `hereTraffic.js` holds HERE-specific fetch + normalization logic, mirroring
  `normalizeIncident`'s output shape exactly (same `RoadSignal` fields: `id`, `severity`,
  `hazardCategory`, `roadway`, `latitude`/`longitude`, `speech`, etc.) so downstream code
  (`filterByBbox`, `sortByFreshness`, the `GET /road-signals` route, `roadAlertsMatching`)
  never needs to know which provider produced a given signal.
- `getRoadSignals({ latitude, longitude, radiusMeters })` in `roadSignals.js` becomes a
  thin dispatcher: check a bounding box; inside it, run the existing NE511 code path
  unchanged; outside it, call `hereTraffic.js`'s fetch function if `HERE_API_KEY` is set,
  otherwise return an empty, non-error result.

Rejected alternative: a formal provider registry (array of `{ coversLocation(),
fetchIncidents() }` objects). Unnecessary abstraction for exactly two providers with a
strict either/or geographic split — YAGNI. Reconsider only if a third provider is ever
actually added.

### Geographic gate

A simple, generously-padded bounding box covering Maine/NH/Vermont, same "flat rectangle
approximation" idiom `boundingBoxDegrees` already uses elsewhere in this file:

```js
const NE511_FOOTPRINT_BBOX = { minLat: 42.6, maxLat: 47.5, minLon: -73.5, maxLon: -66.8 };
```

A location inside this box always uses NE511, even if HERE is configured — New England
511 is free and one step closer to the source (direct from MaineDOT/NHDOT/VTrans), so
there's no reason to spend a paid HERE transaction there. A location outside it uses HERE
if configured, otherwise gets an honest empty result (no error) — this is the same
observable behavior New England 511 already produces today for an out-of-footprint
location (its own bbox filter excludes everything), just now reached via an explicit
check instead of an implicit empty filter result.

**Why not "try NE511 first, fall back to HERE if empty"?** NE511 returning zero signals
for a real in-footprint location with genuinely no current incidents is indistinguishable
from NE511 returning zero signals because the location is outside its coverage — an
empty result is not a reliable signal for "no coverage here." An explicit geographic gate
is required to tell those two cases apart.

## Severity and hazard-category mapping

New functions in `hereTraffic.js`, not a reuse of `mapSeverity` (NE511's version is
specifically a keyword-matching fallback for data with no structured severity field —
degrading HERE's structured fields back through that same keyword matcher would throw
away real signal):

```js
function mapHereSeverity({ criticality, roadClosed, type }) {
  if (roadClosed || type === 'roadClosure' || criticality === 'critical') return 'serious';
  if (criticality === 'major') return 'need_to_know';
  return 'proximity'; // criticality === 'minor', or any unrecognized value
}
```

Hazard category: a direct table for the `type` values observed to map cleanly, falling
back to the **existing, reused** `categorizeHazard()` keyword-matcher (from
`roadSignals.js`, already exported) for anything else — this is what catches
hazmat/accident/weather even though they weren't in HERE's `type` enum as sampled, using
the exact same "most specific first, default to `other`" logic NE511 already relies on:

```js
const HERE_TYPE_TO_CATEGORY = {
  construction: 'construction',
  roadClosure: 'closure',
  congestion: 'congestion',
  laneRestriction: 'obstruction',
};

function categorizeHereIncident(incident) {
  const direct = HERE_TYPE_TO_CATEGORY[incident.type];
  if (direct) return direct;
  return categorizeHazard({
    raw511EventType: incident.typeDescription?.value,
    description: incident.description?.value,
  });
}
```

(Reusing `categorizeHazard` with its existing `raw511EventType` parameter name is a
pragmatic choice — it's a generic keyword matcher over freeform text regardless of what
produced that text, and renaming the parameter would touch working NE511 code for no
functional benefit. Not worth the churn.)

## Response contract

`signals`, `partial`, `generatedAt` — unchanged shape, no changes needed to
`ui/shared/api/types.ts`. Confirmed via grep that no UI code anywhere reads
`networks`/`failedNetworks` (only `partial` is consumed, in
`RoadAlertsHomeBoard.tsx`), so those two fields are free to generalize:

- New England request (unchanged): `networks: ['Maine', 'NewHampshire', 'Vermont']`,
  `failedNetworks` a subset of those on partial failure — exactly today's behavior,
  verified by the existing `roadSignalsEndpoint.test.js` assertions that are not touched.
- HERE request, success: `networks: ['HERE']`, `failedNetworks: []`, `partial: false`.
- HERE request, fetch failure: **throws `UpstreamError`** (→ HTTP 502 at the route level,
  same as `placesSearch.js`'s convention), not a soft partial response. NE511 only
  returns a soft `partial`/`failedNetworks` result when *some* of its 3 networks
  succeeded and others didn't; when *all* of them fail it throws the same way (see
  `getRoadSignals`'s existing `if (failedNetworks.length === NE511_NETWORKS.length) throw
  new UpstreamError(...)`). HERE has exactly one provider, no sub-networks — a failed
  fetch is always the "nothing usable to return" case, so it follows that same existing
  throw convention rather than introducing a new single-item "partial" shape that would
  always represent total failure anyway.
- HERE request, `HERE_API_KEY` unset: `{ signals: [], partial: false, networks: [],
  failedNetworks: [] }` — an honest "nothing here," not an error state.

## Configuration

`HERE_API_KEY` — optional env var, same pattern as `billing.js`'s `PAYPAL_CLIENT_ID`/
`PAYPAL_CLIENT_SECRET`:

```js
function isHereConfigured() {
  return Boolean(process.env.HERE_API_KEY);
}
```

Unset → the HERE path is silently skipped (quiet stub, matching `billing.js`/
`emailDelivery.js`'s pattern for an unconfigured optional integration) — not a startup
warning, since this isn't a security bypass the way `ALLOW_TEST_EMPTY_SERVICE_KEY` is,
just an optional feature that isn't turned on.

## Explicitly deferred (not silently skipped)

- **No caching for the HERE path in v1**, unlike NE511's 15-second per-network cache.
  HERE's query is keyed by a moving lat/lon circle while driving, so a naive
  exact-coordinate cache would rarely hit anyway; the 30,000/month free tier has ample
  headroom for this app's current usage. Worth revisiting if usage ever scales enough for
  cost or rate-limit pressure to become real.
- **No incident deduplication logic.** Not needed under this design — NE511 and HERE
  never run for the same request (strict either/or by geography), so there's nothing to
  deduplicate between them.

## Testing plan

- New `test/hereTraffic.test.js`: unit tests for `mapHereSeverity`,
  `categorizeHereIncident`, and the raw-incident normalizer, using a real fixture
  captured from this session's actual Dallas/Portland HERE responses (not synthetic
  data) — same "confirmed by live sampling" standard `roadSignals.test.js` already holds
  itself to.
- Extend `test/roadSignalsEndpoint.test.js` (or a new file) with route-dispatch cases:
  a Texas coordinate routes to HERE (HERE's fetch mocked, not live), a New England
  coordinate still routes to NE511 unchanged (regression check), `HERE_API_KEY` unset
  behavior for a Texas coordinate, and a HERE fetch failure producing a 502
  (`UpstreamError`) rather than a soft partial response.
- No live network calls in the automated suite — HERE's fetch is mocked the same way the
  existing NE511 tests already mock 511's fetch, so CI runs don't consume the real API
  quota.
