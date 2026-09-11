# Road Alerts Drive Simulator — Design

**Status:** Approved for planning (2026-09-11)

## Goal

A new "Simulate a Drive" sub-tab under Road Alerts. The user types a start
address and a destination address; the app computes a real route between
them over our own street/topology data, estimates a legal speed for each
road segment from its Census road classification, and animates a dot along
the route at that pace on a map whose camera follows the dot as it moves.

## Out of scope (this iteration)

- **Real posted speed limits.** TIGER/Line carries no speed-limit field at
  all (confirmed in `CLAUDE.md`'s existing reroute-feature caveats) — only
  a road-classification code (MTFCC). Speeds here are a labeled *estimate*
  from that classification, never presented as the actual legal limit for
  a specific street.
- **Live hazard checking / voice alerts along the simulated route.** This
  version is a route + moving dot only. A later iteration could reuse
  `RoadAlerts.tsx`'s fetch/speak machinery against the dot's simulated
  position, but that roughly doubles this feature's scope and isn't built
  here.
- **Turn-by-turn instructions.** The map shows the path and the moving
  dot; no spoken or written maneuver list.

## Architecture

```
[Start address] --geocode()--> {lat,lon}
[Dest address]  --geocode()--> {lat,lon}
        |
        v
GET /road-signals/drive-route?startLatitude=...&startLongitude=...
                               &destLatitude=...&destLongitude=...
        |
        v
driveRoute.js: snap both points to nearest topology node,
pgr_dijkstra for the single best path, walk the path's edges,
tag each with its MTFCC-derived estimated speed
        |
        v
{ geometry: LineString, segments: [{coordinates, mtfcc, speedMph}],
  distanceMeters, estimatedDurationSeconds }
        |
        v
RoadAlertsDriveSimulator.tsx: requestAnimationFrame loop walks the
segment list at each segment's speed, updates a dot's position and
recenters the map on every frame via RoadAlertsDriveMap.tsx
```

This reuses the same `streets_topology_nodes` / `streets_routing_edges` /
pgRouting infrastructure `roadReroute.js` already depends on — no new
extension, no new ingest step, just a new query shape (one best path
between two arbitrary points, not "alternates around a hazard").

## MTFCC → estimated speed

`geocoding/ingest.py` only keeps records whose MTFCC starts with `"S"`
(road features) when populating `streets` — but that prefix also covers
non-vehicular features (walkways, stairways, bike paths) that already
participate in `roadReroute.js`'s routing today. This isn't a new problem
this feature introduces; it's called out here so the speed table has a
sane catch-all rather than silently assigning highway speed to a footpath
pgr_dijkstra happens to route through.

| MTFCC | Meaning | Estimated speed |
|-------|---------|------------------|
| S1100 | Primary road (interstate / limited-access highway) | 65 mph |
| S1200 | Secondary road (US/state highway) | 45 mph |
| S1400 | Local street / neighborhood / rural road | 25 mph |
| S1630 | Ramp | 35 mph |
| S1640 | Service drive (frontage road) | 25 mph |
| S1500 | Vehicular trail (4WD) | 15 mph |
| anything else (walkway, stairway, alley, parking lot road, bike/bridle path, etc.) | 15 mph (conservative default) |

Lives as a plain lookup object (`MTFCC_SPEED_MPH`) in the new
`driveRoute.js`, with a documented fallback for an unrecognized code. The
UI states plainly, near the Start button, that speeds are estimated from
road type, not real posted limits — matching the existing detour
feature's own "estimate, not exact" disclosures.

## Backend changes

### `geocoding/schema.py`

`CREATE_ROUTING_EDGES_VIEW_SQL` gains `s.mtfcc AS mtfcc` in its SELECT
list. `streets_routing_edges` is a view (`CREATE OR REPLACE VIEW`), so
this is a zero-downtime, backward-compatible change — existing selects
naming specific columns (e.g. `roadReroute.js`'s `id, source, target,
cost`) are unaffected. Any database that already has this view built
(local dev, the test droplet) needs `refresh_routing_topology(dsn)`
re-run once to pick up the new column — the same one-time-per-database
manual step the original pgRouting/topology setup already required. This
must happen on the test droplet as part of deploying this feature, not
just locally.

### `geocoding-server/src/driveRoute.js` (new)

Modeled closely on `roadReroute.js`, reusing its `nearestTopologyNodeId`
pattern (same `MAX_NODE_SNAP_DISTANCE_METERS` guard) and
`ST_AsGeoJSON`-based edge-geometry assembly:

- `getDriveRoute(db, { startLatitude, startLongitude, destLatitude, destLongitude })`
- Validates both coordinates (`validateCoordinate`, reused from
  `nextCrossStreet.js`).
- Straight-line distance sanity cap — proposing 300km (≈186 miles) —
  beyond which throws `OutOfRangeError` (422). This isn't a real routing
  limit, just a guard against a client requesting an enormous
  cross-country graph search; the number is generous enough to cover any
  realistic Maine/NH/Texas-area trip this app's data actually covers.
- Snaps both points to the nearest topology node; `NotFoundError` (404)
  if either isn't within `MAX_NODE_SNAP_DISTANCE_METERS` of real routable
  data (identical wording convention to `roadReroute.js`'s own message).
- Single-path query via `pgr_dijkstra` (not `pgr_ksp` — this feature only
  ever needs the one best route, not alternates) between the two nodes,
  no avoid-area (unlike the hazard detour, there's nothing to avoid here).
- `NotFoundError` if `pgr_dijkstra` returns no path (disconnected graph
  areas — e.g. start and destination are both real but on unconnected
  street islands in the current data).
- Walks the resulting edge sequence in order (reusing the
  reverse-if-traveled-backward logic `buildPathGeometry` already has,
  generalized to also carry each edge's `mtfcc`), producing:
  - `segments`: one entry per traversed edge:
    `{ coordinates: [[lon,lat], ...], mtfcc, speedMph, distanceMeters }`
  - `geometry`: the flattened single `LineString` (all segments'
    coordinates concatenated, shared endpoints deduplicated) — convenient
    for a caller that just wants to draw the whole path without walking
    segments.
  - `distanceMeters`: sum of all segments' lengths.
  - `estimatedDurationSeconds`: sum of each segment's
    `distanceMeters / (speedMph * 0.44704)` (mph → m/s).

### `GET /road-signals/drive-route` (new, in `server.js`)

Query params `startLatitude`, `startLongitude`, `destLatitude`,
`destLongitude` — same param-naming convention as the existing
`/road-signals/reroute` endpoint's `driverLatitude`/`hazardLatitude`
pairing. Calls `getDriveRoute`, returns its result as JSON. Errors map to
HTTP status the same way every other endpoint here does
(`NotFoundError`→404, `OutOfRangeError`→422, `ValidationError`→400).

### `ui/shared/api/client.ts`

New `getDriveRoute({ startLatitude, startLongitude, destLatitude,
destLongitude })`, mirroring `getRoadReroute`'s existing shape.

## Frontend changes

### `RoadAlertsTabs.tsx`

Add a 4th tab: `{ to: '/road-alerts-drive-simulator', label: 'Simulate a Drive', icon: 'driveSimulator' }` (new icon, added to `icons.tsx` alongside the existing `roadAlerts`/`neighborhood`/`weightedPoints` set).

### `RoadAlertsDriveSimulator.tsx` (new page)

- Two address text inputs (Start, Destination) + a "Plan route" button
  that geocodes both via the existing `geocode()` client function (the
  same one every other address-consuming page in this app already uses)
  and then calls `getDriveRoute`.
- On a successful route: shows total distance, estimated duration, and
  Start / Pause / Reset controls, plus the speed-estimate disclaimer.
- Animation loop (`requestAnimationFrame`): tracks `distanceTraveledMeters`
  as a ref, advanced each frame by `elapsedSeconds * currentSegment.speedMph
  * 0.44704`. A small helper walks the flattened segment list to turn a
  cumulative distance into a `{lon, lat}` position (linear interpolation
  within the current segment) and exposes the current segment's
  `speedMph`/`mtfcc` for the readout. Pause stops the rAF loop without
  resetting `distanceTraveledMeters`; Reset zeroes it and re-fits the map
  to the whole route.
- On reaching the route's total length, the loop stops and the dot sits
  at the destination.

### `RoadAlertsDriveMap.tsx` (new component)

Modeled on `RoadRerouteMap.tsx`'s GeoJSON line-source/layer setup (one
`line` layer for the route, `fitBounds` on first load), plus:
- A single `Marker` for the moving dot, whose `setLngLat` is called every
  animation frame from the parent (a plain prop, `dotPosition: {latitude,
  longitude}`, not internal state — the parent's rAF loop owns the clock).
- `map.easeTo({ center: [lon, lat], duration: <frame interval> })` each
  frame the dot moves, rather than one-shot `flyTo` — keeps the camera
  smoothly centered on the dot instead of jumping. A `following` boolean
  prop lets the user pan away without the next frame yanking the camera
  back (set to `false` on manual drag via the map's own `dragstart`
  event, same idea as many turn-by-turn apps' "recenter" affordance) —
  paired with a small "Recenter" button that sets it back to `true`.
- Start/destination markers (fixed, like `RoadRerouteMap`'s driver/hazard/
  rejoin markers) so the whole planned route is visually anchored even
  while zoomed in following the dot.

## Error handling

| Condition | Response |
|-----------|----------|
| Either address fails to geocode | Inline error in the page, same pattern as every other address-consuming page here; no route requested |
| Either point >300km apart (straight-line) | `OutOfRangeError` → 422, "these two locations are too far apart for this feature" |
| Either point not near routable street data | `NotFoundError` → 404, "no routable street data near this location yet" (matches `roadReroute.js`'s wording) |
| No path exists between the two (disconnected graph) | `NotFoundError` → 404, "no route found between these two locations" |

## Testing plan

- New `geocoding-server/test/driveRoute.test.js` (TDD, real Postgres/
  PostGIS/pgRouting via `test/helpers.js`, a new small fixture module
  analogous to `roadRerouteFixture.js` but without the hazard-avoidance
  wrinkle — needs `mtfcc` seeded per edge and added to its own
  `streets`/`streets_routing_edges` `CREATE` statements, since that test
  fixture builds its own copy of the view rather than depending on
  `geocoding/schema.py`):
  - happy path: two nodes with a known path, asserts `segments`,
    `distanceMeters`, `estimatedDurationSeconds` shape and values
  - `MTFCC_SPEED_MPH` mapping: known codes + the unrecognized-code
    fallback
  - too-far-apart → `OutOfRangeError`
  - unroutable point → `NotFoundError`
  - disconnected graph → `NotFoundError`
- New endpoint tests (own file or added to an existing
  `roadSignalsEndpoint`-style file): happy path, bad/missing coordinates
  → 400, each error case above mapped to its HTTP status.
- `tests/test_routing_topology.py` — no new test required (the view
  change is additive; the existing `pgr_ksp`-based test doesn't select
  `mtfcc` and stays valid), but worth a quick manual check that
  `refresh_routing_topology` still runs clean after the schema change.
- Frontend: `tsc -b --noEmit` + `npm test -- --run`, no new frontend test
  file — matches this session's established precedent for page-level
  Road Alerts UI work (`RoadAlertsHomeBoard.tsx`, `RoadAlerts.tsx` itself
  have none either).

## Deployment note

Unlike every other change this session, this one touches a Postgres
*view definition* that a deployed database already has built. Shipping
this to the test droplet requires, in addition to the usual code deploy,
re-running `refresh_routing_topology` against that droplet's `geocoding`
database once — `routing_topology.py` has no standalone CLI entry point
today (it's only ever called from `annual_update.py`'s `main()`, which
also does a full TIGER/E911 re-ingest — far more than this needs), so the
plan should add a tiny one-off invocation (e.g. `python -c "from
geocoding.routing_topology import refresh_routing_topology;
refresh_routing_topology('<dsn>')"`, or a minimal new script if that
reads too awkwardly) rather than running the full annual maintenance job
just to pick up one new view column.
