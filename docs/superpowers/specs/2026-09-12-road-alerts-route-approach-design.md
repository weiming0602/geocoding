# Road Alerts Route-Approach Relevance — Design

**Status:** Approved for planning (2026-09-12)

## Goal

While driving, decide which hazards are actually relevant using not just
"is this roughly ahead of me" (today's heading-cone check) but "does my
recent movement look like I'm actually heading toward one of my known
routine destinations, and if so, is this hazard on the way there." When
the answer changes mid-drive (a turn, a route the driver didn't take
before), the alerts shown update on the very next check, not just once
at trip start.

This closes two real gaps:

1. **Desktop's `RoadAlerts.tsx` doesn't use weighted points for relevance
   at all today** — it fetches them only to trigger a background refresh.
   Mobile's `RoadAlertsForm.tsx` already cross-references hazards against
   *every* stored weighted point via `ui/shared/roadAlertsMatching.ts`'s
   `findAlertsForWeightedPoints` (a straight-line corridor check) — this
   brings desktop to the same baseline.
2. **Neither app currently narrows down *which* weighted point the driver
   is actually approaching** — `findAlertsForWeightedPoints` checks every
   stored routine street indiscriminately. A driver near a cluster of
   several routine streets in different directions gets matched against
   all of them, whether or not their current movement actually trends
   that way.

## Out of scope

- **Real street-network route tracing** (pgRouting) to replace the
  existing straight-line corridor check — explicitly deferred; see the
  brainstorming conversation this spec came from. `hazardBetweenUserAndPoint`
  stays exactly as it is today.
- **The drive-simulator's alert-evaluation extension** (using a specified
  start/destination to mimic a drive and observe which alerts fire) — a
  separate, sequenced follow-up spec, since it depends on this one's
  `approachedWeightedPoints` existing first. Not designed here.

## Privacy

This adds an **in-memory-only** trail of recent position fixes (see
below) — never written to the database, never sent to the server as its
own request, discarded the moment the tab/screen closes or driving stops.
`docs/ROAD_ALERTS_DESIGN.md`'s Privacy model section documents a
deliberate 2026-09-03 decision that **no raw trip trace is ever
persisted** specifically because a sequence of timestamped points is
highly re-identifying. This feature doesn't touch that decision — the
trail lives only in the browser/app's own memory for the current session,
same as `position`/`lastFixRef` already do in `RoadAlerts.tsx` today. A
short addendum noting this addition belongs in that doc's Privacy model
section (see Task list below) so a future reader doesn't have to
reverse-engineer that this is still consistent with the 2026-09-03
decision.

## Architecture

```
Every hazard-check tick (existing throttle, ~15s while moving):
  1. Append {latitude, longitude, timestampMs} to a capped, in-memory
     trail (last 4 samples, oldest dropped) -- per-app state, not shared.
  2. approachedWeightedPoints(trail, weightedPoints) -- narrows the
     account's full weighted-point list down to just the ones the
     trail's recent direction is actually consistent with.
  3. findAlertsForWeightedPoints(currentPosition, narrowedPoints, signals)
     -- unchanged, existing corridor-check logic.
  4. Matched hazards: eligible for auto-speak (OR'd with the existing
     isAhead cone check, same as mobile today) AND get a visible
     "· on your route" tag in the list (new on desktop; mobile already
     shows this text today, just fed from the unnarrowed match).
```

Steps 2-3 re-run on every tick with the current (sliding) trail, so a
route change is reflected within one tick of the driver's new direction
actually showing up in the trail -- not computed once and left stale.

## `approachedWeightedPoints` (new, `ui/shared/roadAlertsMatching.ts`)

```ts
import type { TimedCoordinates } from './geo';

export function approachedWeightedPoints(
  trail: TimedCoordinates[],
  weightedPoints: WeightedPoint[],
  options: { minTrailDisplacementMeters?: number; approachConeDeg?: number } = {}
): WeightedPoint[]
```

- `minTrailDisplacementMeters` (default **50**): below this, the trail's
  two ends are too close together for their bearing to mean anything —
  ordinary GPS jitter, a stop light, a trip just starting. Larger than
  PR #50's 15m per-tick jitter guard, since this measures displacement
  across the whole (longer) trail window, not two adjacent fixes.
- `approachConeDeg` (default **45**, full width, same convention as
  `isAhead`'s existing `coneDeg` parameter): notably tighter than
  `isAhead`'s own default 90° cone, since this answers a more specific
  question ("is this a plausible destination for the direction I'm
  actually moving") than "is this roughly ahead of me at all."

**Algorithm:**
1. If `trail.length < 2`, return `weightedPoints` unchanged — not enough
   data to compute a trend at all; degrade to today's "check every
   weighted point" behavior rather than filtering out everything.
2. `oldest = trail[0]`, `newest = trail[trail.length - 1]`.
3. If `haversineDistanceMeters(oldest, newest) < minTrailDisplacementMeters`,
   return `weightedPoints` unchanged — same reasoning as step 1, just a
   different cause (not moving enough yet to trust the trend).
4. `trendBearing = bearingDegrees(oldest, newest)`.
5. For each point in `weightedPoints`, compute
   `bearingDegrees(newest, point)` (bearing from the *current* position,
   not the trail's start) and keep the point only if that bearing is
   within `approachConeDeg / 2` of `trendBearing`.
6. Return the filtered list. (Order doesn't matter —
   `findAlertsForWeightedPoints` doesn't depend on it.)

**Trail window (4 samples, ~60 seconds at the existing ~15s hazard-check
cadence):** a deliberate trade-off. Longer would smooth out noise better
but make a real turn take longer to outweigh the pre-turn direction
still baked into the average; shorter reacts faster but is more
sensitive to a single noisy fix. Chosen to prioritize responsiveness to
an actual route change, per this spec's motivating conversation.

## Desktop wiring (`ui/desktop/src/pages/RoadAlerts.tsx`)

- **Fetch and store real weighted points** (currently fetched only for
  a fire-and-forget background refresh, see `refreshRealWeightedPoints`)
  — add a `weightedPointsRef` populated the same way mobile's
  `realWeightedPoints` is, refreshed after each ping the same way mobile
  already does.
- **New `trailRef = useRef<TimedCoordinates[]>([])`**, appended to on the
  same tick `fetchSignals` already runs on (the existing
  `POLL_MIN_INTERVAL_MS`-gated block in `onPosition`), capped to the last
  4 entries. Reset to `[]` in `handleStart`, alongside the existing
  `lastFixRef`/`hasDetectedMovementRef` resets from PR #50 — a new trip
  shouldn't inherit a stale trail from a previous session.
- **In `fetchSignals`**, after getting `response.signals`:
  ```ts
  const candidatePoints = approachedWeightedPoints(trailRef.current, weightedPointsRef.current);
  const routeAlerts = findAlertsForWeightedPoints({ latitude, longitude }, candidatePoints, response.signals);
  const onRouteIds = new Set(routeAlerts.map((a) => a.signal.id));
  setOnRouteIds(onRouteIds);
  ```
- **Auto-speak loop**: `const ahead = onRouteIds.has(signal.id) || isAhead(heading, bearing);` — identical pattern to mobile's existing code.
- **New `onRouteIds` state** (`useState<Set<string>>(new Set())`).
- **Visible tag**: append `onRoute ? ' · on your route' : !ahead ? ' · behind you' : ''` to the card's existing kicker line — same copy mobile already uses, for consistency between the two apps.

## Mobile wiring (`ui/mobile/components/RoadAlertsForm.tsx`)

Already has `onRouteIds`/the visible "· on your route" tag (line ~1130)
and calls `findAlertsForWeightedPoints` against the full weighted-point
list. Two changes:
- **New trail tracking** — mobile has no equivalent of desktop's
  `lastFixRef` at all yet (it relies on `expo-location`'s own generally-
  reliable heading rather than deriving one, per the existing Real-time
  matching design). This adds a mobile-side `trailRef`, appended on the
  same tick `findAlertsForWeightedPoints` already runs on, same 4-sample
  cap and reset-on-start as desktop.
- **Narrow through `approachedWeightedPoints`** before calling
  `findAlertsForWeightedPoints`, exactly as in desktop's wiring above.

## Testing plan

- New tests in `ui/shared/roadAlertsMatching.test.ts` for
  `approachedWeightedPoints` (TDD): a trail trending toward a weighted
  point keeps it; a trail trending away/perpendicular excludes it; a
  trail with only one sample, or too little displacement, passes every
  point through unchanged; multiple weighted points, only the ones
  consistent with the trend survive.
- Desktop/mobile wiring itself: no existing test file for either
  `RoadAlerts.tsx` or `RoadAlertsForm.tsx` — verified via `tsc -b
  --noEmit` + `npm test -- --run` + manual click-through, matching this
  session's established precedent for this kind of page-level wiring.

## Documentation

Add a short addendum to `docs/ROAD_ALERTS_DESIGN.md`'s Privacy model
section (see "Privacy" above) noting the in-memory, non-persisted trail
this feature adds, and why it doesn't revisit the 2026-09-03 "no raw
trace stored" decision.
