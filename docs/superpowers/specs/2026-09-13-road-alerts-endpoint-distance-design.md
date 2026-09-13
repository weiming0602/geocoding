# Road Alerts Weighted-Point Endpoint-Distance Filtering — Design

**Status:** Approved for planning (2026-09-13)

## Goal

Strengthen the existing "weighted points must never be a trip's destination"
privacy guarantee from a purely *temporal* exclusion (only the literal
first/last GPS fix of a trip is excluded) to a *spatial* one (no weighted
point may be recorded within 300m of either the trip's origin or its
destination). Observed directly in the test database: on short trips, a
mid-trip ping that isn't the last fix can still land close enough to the
destination to be meaningfully identifying, which the current
temporal-only exclusion doesn't catch.

## Background

`geocoding-server/src/weightedPoints.js`'s `recordWeightedPointPing`
excludes a ping only when the caller marks it `isEndpoint: true` — set for
exactly one fix at trip start and one at trip end (`RoadAlerts.tsx`,
`RoadAlertsForm.tsx`). Every ping in between is recorded regardless of how
close it actually is to where the trip started or will end. For a long
highway commute this is rarely an issue (a 3-minute-interval ping is
usually genuinely far from either end); for a short local errand, it can
land a block or two from the destination -- not a destination itself by
the letter of the rule, but close enough to reveal it in practice.

## Approach

**Buffer mid-trip candidate pings client-side (never sent immediately);
filter by real distance from both endpoints once the destination is known
at trip end; send only the survivors.** This mirrors the existing
in-memory-only trail pattern from the route-approach feature
(`trailRef` in both apps) -- collected during a live trip, never
persisted, discarded on Stop.

**No server-side changes at all.** `weightedPoints.js`'s endpoint,
schema, and `isEndpoint` no-op behavior are untouched -- the origin and
destination pings themselves keep going out exactly as today. This is
purely a change to *when* and *which* mid-trip pings the client sends.

### Tradeoffs, accepted explicitly

1. **Route-approach freshness.** `refreshRealWeightedPoints` is currently
   called after every successful non-endpoint ping, so a route becoming
   routine mid-trip is immediately usable for that same trip's alert
   matching. Under this change, mid-trip pings only reach the server at
   trip end, so that refresh now happens once, at Stop, instead of
   continuously during the drive. Still same-session, just not
   same-instant. Low practical impact: qualifying a new point needs 3
   pings inside a 7-day window (`MIN_PINGS_TO_QUALIFY`/
   `QUALIFYING_WINDOW_DAYS`), rarely satisfiable within a single trip
   regardless.
2. **Abnormal termination.** If the app is killed or crashes mid-trip
   (not a clean Stop), this trip's buffered candidates are lost entirely,
   where today they'd already have been sent as they occurred. Consistent
   with this feature's existing tolerance for imperfect data --
   `pingWeightedPoint`'s own doc comment already calls every ping
   "best-effort... background-enhancement noise," never something a
   failure should be treated as a real loss.

## `pingsFarFromTripEndpoints` (new, `ui/shared/roadAlertsMatching.ts`)

```typescript
export function pingsFarFromTripEndpoints(
  candidates: Coordinates[],
  origin: Coordinates,
  destination: Coordinates,
  minDistanceMeters: number = 300
): Coordinates[] {
  return candidates.filter(
    (candidate) =>
      haversineDistanceMeters(candidate, origin) >= minDistanceMeters &&
      haversineDistanceMeters(candidate, destination) >= minDistanceMeters
  );
}
```

`minDistanceMeters` defaults to 300 directly (no separate constant/options
object needed the way `approachedWeightedPoints` has one -- there's only
one parameter here, and neither app needs to override it, so a bare
default argument is simpler). `Coordinates` is already imported in this
file from `./api/types`; `haversineDistanceMeters` is already imported
from `./geo`. Both `candidates` and the two endpoints keep only
`latitude`/`longitude` -- neither app currently threads a `tlid` through
`pingWeightedPoint` at all, so there's nothing else to carry.

## Desktop wiring (`ui/desktop/src/pages/RoadAlerts.tsx`)

- **Two new refs**, alongside the existing `trailRef`/`weightedPointsRef`:
  - `pendingPingsRef = useRef<{ latitude: number; longitude: number }[]>([])`
    -- this trip's buffered mid-trip candidates, never sent until Stop.
  - `tripOriginRef = useRef<{ latitude: number; longitude: number } | null>(null)`
    -- captured once, at the trip's first fix, so it's available at Stop
    alongside the (already-known-then) destination.
  Both use the same inline `{ latitude: number; longitude: number }` shape
  `positionRef`/`lastFixRef` already use in this file -- no new type import
  needed for the refs themselves.
- **In `onPosition`'s first-fix-of-session branch**, alongside the
  existing origin ping:
  ```typescript
  if (isFirstPositionOfSessionRef.current) {
    isFirstPositionOfSessionRef.current = false;
    tripOriginRef.current = { latitude, longitude };
    pingWeightedPoint(latitude, longitude, true);
    return;
  }
  ```
- **In `onPosition`'s mid-trip branch**, replace the immediate ping with a
  buffer push:
  ```typescript
  if (now - lastWeightedPingAtRef.current < WEIGHTED_POINT_PING_INTERVAL_MS) return;
  lastWeightedPingAtRef.current = now;
  pendingPingsRef.current.push({ latitude, longitude });
  ```
  (Was: `pingWeightedPoint(latitude, longitude, false);` on that last line.)
- **In `handleStart`**, alongside the existing per-trip resets:
  ```typescript
  pendingPingsRef.current = [];
  tripOriginRef.current = null;
  ```
- **In `handleStop`**, flush the buffer before/alongside the existing
  destination ping:
  ```typescript
  const handleStop = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    window.speechSynthesis?.cancel();
    setWatching(false);

    trailRef.current = [];
    setOnRouteIds(new Set());

    // The last known fix is this trip's destination -- used both to
    // report the endpoint ping (never recorded, see pingWeightedPoint)
    // and, together with tripOriginRef, to filter this trip's buffered
    // mid-trip candidates down to the ones that turned out to actually
    // be far enough from both ends -- see
    // docs/superpowers/specs/2026-09-13-road-alerts-endpoint-distance-design.md.
    const lastPosition = positionRef.current;
    const origin = tripOriginRef.current;
    if (origin && lastPosition && pendingPingsRef.current.length > 0) {
      const survivors = pingsFarFromTripEndpoints(pendingPingsRef.current, origin, lastPosition);
      for (const point of survivors) {
        pingWeightedPoint(point.latitude, point.longitude, false);
      }
    }
    pendingPingsRef.current = [];

    if (lastPosition) {
      pingWeightedPoint(lastPosition.latitude, lastPosition.longitude, true);
    }
  }, [pingWeightedPoint]);
  ```
- **New import**: `pingsFarFromTripEndpoints` from
  `'../../../shared/roadAlertsMatching'` (already importing
  `approachedWeightedPoints`/`findAlertsForWeightedPoints`/`WeightedPoint`
  from that module -- extend the same import line).

## Mobile wiring (`ui/mobile/components/RoadAlertsForm.tsx`)

Identical shape to desktop, adjusted for this file's own patterns
(`Location.LocationObject`, `Date.now()` in place of `pos.timestamp`,
`subscriptionRef`/`Speech` instead of `watchIdRef`/`speechSynthesis`):

- Same two new refs (`pendingPingsRef`, `tripOriginRef`), same inline type.
- Same edit to `onPosition`'s first-fix branch (`tripOriginRef.current = { latitude, longitude };` alongside the existing origin ping).
- Same edit to `onPosition`'s mid-trip branch (buffer push replaces the immediate `pingWeightedPoint(latitude, longitude, false)`).
- Same two-line reset added to `handleStart`.
- Same flush-then-endpoint-ping logic added to `handleStop`, using this file's own `positionRef`/`pingWeightedPoint`.
- Same import extension: `pingsFarFromTripEndpoints` added to the existing `approachedWeightedPoints`/`findAlertsForWeightedPoints`/`WeightedPoint` import from `'../../shared/roadAlertsMatching'`.

## Testing plan

- New tests in `ui/shared/roadAlertsMatching.test.ts` for
  `pingsFarFromTripEndpoints` (TDD), reusing the file's existing `USER`/
  `offsetMeters` helpers:
  - a candidate well clear of both origin and destination survives
  - a candidate within 300m of the origin is dropped
  - a candidate within 300m of the destination is dropped
  - a candidate exactly at the 300m boundary (both directions: just
    inside, just outside)
  - an empty candidates array returns an empty array
  - a custom `minDistanceMeters` widens or narrows what survives
- Desktop/mobile wiring itself: no existing test file for either page
  (matches this session's established precedent for this kind of
  page-level wiring) -- verified via `tsc -b --noEmit` /
  `npx tsc --noEmit` and a manual click-through, same as the
  route-approach feature's own Task 2/3.

## Documentation

Add a short addendum to `docs/ROAD_ALERTS_DESIGN.md`'s Privacy model
section, alongside the existing 2026-09-12 route-approach-trail addendum,
noting: mid-trip pings are now buffered client-side and filtered against
both trip endpoints (300m) before being sent, strengthening the existing
"never record a destination" rule from a temporal-only guarantee to a
spatial one; and explicitly naming the two accepted tradeoffs from this
document's own Approach section above (delayed same-session
route-approach freshness, and loss of unflushed candidates on abnormal
app termination).
