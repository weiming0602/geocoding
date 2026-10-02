# Road Alerts Route-Approach Relevance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow which routine destination a driver looks like they're actually heading toward (from a short in-memory movement trail), and use that to decide which hazards are relevant on both desktop and mobile's live driving screens -- closing desktop's current total gap (it doesn't use weighted points for relevance at all) and mobile's existing "check every routine street indiscriminately" imprecision.

**Architecture:** One new pure function (`approachedWeightedPoints`) in the already-shared `ui/shared/roadAlertsMatching.ts`, consumed identically by both apps' live driving screens. Each app keeps its own short (4-sample), in-memory-only trail of recent GPS fixes -- never persisted, discarded at trip end -- and narrows its weighted points through the new function before running the existing `findAlertsForWeightedPoints` corridor check.

**Tech Stack:** TypeScript, React (desktop)/React Native (mobile), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-road-alerts-route-approach-design.md`

## Global Constraints

- `minTrailDisplacementMeters` default: **50** (meters) -- below this, the trail's two ends are too close for their bearing to mean anything.
- `approachConeDeg` default: **45** (degrees, full width, same convention as `isAhead`'s `coneDeg`) -- tighter than `isAhead`'s own 90° default.
- Trail capacity: **4 samples** (~60 seconds at the existing ~15s hazard-check cadence on both apps).
- The trail is **in-memory only, per-app, never persisted to any database or sent to the server as its own request** -- this is a hard constraint from the spec's Privacy section, not a preference.
- Visible tag copy: **`· on your route`** (exact string, already used by mobile -- desktop must match it verbatim for consistency).

---

### Task 1: `approachedWeightedPoints` in the shared matching module

**Files:**
- Modify: `ui/shared/roadAlertsMatching.ts`
- Test: `ui/shared/roadAlertsMatching.test.ts`

**Interfaces:**
- Consumes: `TimedCoordinates` (already exists in `ui/shared/geo.ts`, added in a prior PR -- `{ latitude: number; longitude: number; timestampMs: number }`), `bearingDegrees`/`haversineDistanceMeters` (already imported into `roadAlertsMatching.ts`), the existing `WeightedPoint` type in the same file.
- Produces: `export function approachedWeightedPoints(trail: TimedCoordinates[], weightedPoints: WeightedPoint[], options?: { minTrailDisplacementMeters?: number; approachConeDeg?: number }): WeightedPoint[]` -- Task 2 and Task 3 both call this exact signature.

- [ ] **Step 1: Write the failing tests**

Add this import to the top of `ui/shared/roadAlertsMatching.test.ts` (extend the existing import from `./roadAlertsMatching`, don't duplicate the statement):

```typescript
import {
  approachedWeightedPoints,
  crossTrackDistanceMeters,
  alongTrackDistanceMeters,
  findAlertsForWeightedPoints,
  hazardBetweenUserAndPoint,
  type WeightedPoint,
} from './roadAlertsMatching';
```

Append this new `describe` block at the end of the file (after the existing `findAlertsForWeightedPoints` block's closing `});`):

```typescript
describe('approachedWeightedPoints', () => {
  // A trail moving from USER 100m north -- above the 50m default
  // displacement threshold, so its trend (due north) is trusted.
  const TRAIL_TOWARD_NORTH = [
    { ...USER, timestampMs: 0 },
    { ...offsetMeters(USER, 100, 0), timestampMs: 15000 },
  ];

  test('keeps a weighted point the trail is trending toward', () => {
    const point = makeWeightedPoint(ROUTINE_POINT, 0.8); // 5km due north of USER

    const result = approachedWeightedPoints(TRAIL_TOWARD_NORTH, [point]);

    expect(result).toEqual([point]);
  });

  test('excludes a weighted point the trail is trending away from', () => {
    const trailTowardSouth = [
      { ...USER, timestampMs: 0 },
      { ...offsetMeters(USER, -100, 0), timestampMs: 15000 },
    ];
    const point = makeWeightedPoint(ROUTINE_POINT, 0.8); // due north -- opposite direction

    expect(approachedWeightedPoints(trailTowardSouth, [point])).toHaveLength(0);
  });

  test('passes every point through unfiltered when the trail has fewer than 2 samples', () => {
    const point = makeWeightedPoint(offsetMeters(USER, 0, 5000), 0.8); // due east -- would fail a north trend

    const result = approachedWeightedPoints([{ ...USER, timestampMs: 0 }], [point]);

    expect(result).toEqual([point]);
  });

  test('passes every point through unfiltered when trail displacement is below the reliability threshold', () => {
    // Only 10m apart -- below the 50m default, even though the direction
    // implied (north) doesn't match this point's actual direction (east).
    const barelyMovedTrail = [
      { ...USER, timestampMs: 0 },
      { ...offsetMeters(USER, 10, 0), timestampMs: 15000 },
    ];
    const point = makeWeightedPoint(offsetMeters(USER, 0, 5000), 0.8); // due east

    const result = approachedWeightedPoints(barelyMovedTrail, [point]);

    expect(result).toEqual([point]);
  });

  test('keeps only the points consistent with the trend, given points in different directions', () => {
    const northPoint = makeWeightedPoint(ROUTINE_POINT, 0.8); // due north
    const eastPoint = makeWeightedPoint(offsetMeters(USER, 0, 5000), 0.6); // due east

    const result = approachedWeightedPoints(TRAIL_TOWARD_NORTH, [northPoint, eastPoint]);

    expect(result).toEqual([northPoint]);
  });

  test('a custom approachConeDeg widens or narrows what counts as consistent', () => {
    // ~30 degrees east of the trail's north trend -- inside a wide cone,
    // outside the default 45-degree one.
    const diagonalPoint = makeWeightedPoint(offsetMeters(USER, 5000, 2887), 0.8);

    expect(approachedWeightedPoints(TRAIL_TOWARD_NORTH, [diagonalPoint])).toHaveLength(0);
    expect(
      approachedWeightedPoints(TRAIL_TOWARD_NORTH, [diagonalPoint], { approachConeDeg: 90 })
    ).toEqual([diagonalPoint]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ui/shared && npx vitest run roadAlertsMatching.test.ts`
Expected: FAIL -- `approachedWeightedPoints is not a function` (or a TypeScript import error naming it), since it doesn't exist yet.

- [ ] **Step 3: Implement `approachedWeightedPoints`**

In `ui/shared/roadAlertsMatching.ts`, change the top import line from:

```typescript
import type { Coordinates, RoadSignal } from './api/types';
import { EARTH_RADIUS_METERS, bearingDegrees, haversineDistanceMeters, toRadians } from './geo';
```

to:

```typescript
import type { Coordinates, RoadSignal } from './api/types';
import { EARTH_RADIUS_METERS, bearingDegrees, haversineDistanceMeters, toRadians } from './geo';
import type { TimedCoordinates } from './geo';
```

Then append this to the end of the file (after `findAlertsForWeightedPoints`'s closing `}`):

```typescript
export type ApproachOptions = {
  /** Below this, the trail's two ends are too close for their bearing to mean anything -- ordinary GPS jitter, a stop light, a trip just starting. */
  minTrailDisplacementMeters?: number;
  /** Full cone width in degrees, same convention as isAhead's own coneDeg -- how far a candidate point's bearing from the trail's newest fix may differ from the trail's own trend bearing and still count as "consistent." */
  approachConeDeg?: number;
};

export const DEFAULT_APPROACH_OPTIONS: Required<ApproachOptions> = {
  minTrailDisplacementMeters: 50,
  approachConeDeg: 45,
};

/**
 * Narrows `weightedPoints` down to the ones a driver's recent movement
 * (`trail`, oldest first) actually looks like it's heading toward --
 * distinct from findAlertsForWeightedPoints's own geometric "is a hazard
 * between here and there" check, which considers every weighted point
 * regardless of whether the driver is actually trending that way.
 *
 * Falls back to returning every weighted point unfiltered when the trail
 * doesn't have enough reliable signal yet (fewer than two samples, or too
 * little displacement between the oldest and newest -- a trip just
 * starting, or stopped at a light): this degrades to the same "check
 * everything" behavior the caller had before this function existed,
 * rather than silently going quiet.
 */
export function approachedWeightedPoints(
  trail: TimedCoordinates[],
  weightedPoints: WeightedPoint[],
  options: ApproachOptions = {}
): WeightedPoint[] {
  const { minTrailDisplacementMeters, approachConeDeg } = { ...DEFAULT_APPROACH_OPTIONS, ...options };
  if (trail.length < 2) return weightedPoints;

  const oldest = trail[0];
  const newest = trail[trail.length - 1];
  if (haversineDistanceMeters(oldest, newest) < minTrailDisplacementMeters) return weightedPoints;

  const trendBearing = bearingDegrees(oldest, newest);
  return weightedPoints.filter((point) => {
    const bearingToPoint = bearingDegrees(newest, point);
    const diff = Math.abs(((bearingToPoint - trendBearing + 540) % 360) - 180);
    return diff <= approachConeDeg / 2;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui/shared && npx vitest run`
Expected: PASS -- all tests in the file, including the new `approachedWeightedPoints` block (28 tests total: 22 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add ui/shared/roadAlertsMatching.ts ui/shared/roadAlertsMatching.test.ts
git commit -m "Add approachedWeightedPoints: narrow routine destinations by recent movement trend"
```

---

### Task 2: Wire desktop's `RoadAlerts.tsx` up to weighted-point relevance

**Files:**
- Modify: `ui/desktop/src/pages/RoadAlerts.tsx`

**Interfaces:**
- Consumes: `approachedWeightedPoints`, `findAlertsForWeightedPoints`, `type WeightedPoint` (Task 1, `../../../shared/roadAlertsMatching`); `type TimedCoordinates` (`../../../shared/geo`, already exists).
- Produces: nothing new consumed elsewhere -- this task is a leaf.

This task has no new pure logic to unit-test (no existing test file covers `RoadAlerts.tsx` today, matching this repo's established precedent for this file) -- verified by typecheck, the existing test suite, and a manual click-through instead.

- [ ] **Step 1: Add the new imports**

In `ui/desktop/src/pages/RoadAlerts.tsx`, change:

```typescript
import { bearingDegrees, estimateSpeedMetersPerSecond, haversineDistanceMeters, isAhead } from '../../../shared/geo';
```

to:

```typescript
import { bearingDegrees, estimateSpeedMetersPerSecond, haversineDistanceMeters, isAhead } from '../../../shared/geo';
import type { TimedCoordinates } from '../../../shared/geo';
import { approachedWeightedPoints, findAlertsForWeightedPoints, type WeightedPoint } from '../../../shared/roadAlertsMatching';
```

- [ ] **Step 2: Add the trail-capacity constant**

Change:

```typescript
const MIN_RELIABLE_DISPLACEMENT_METERS = 15;
```

to:

```typescript
const MIN_RELIABLE_DISPLACEMENT_METERS = 15;
// How many recent position samples the in-memory route-approach trail
// keeps -- ~60 seconds at the existing ~15s hazard-check cadence. Short
// on purpose: a real route change (a turn) should outweigh the pre-turn
// direction quickly, not stay diluted by many minutes of stale samples.
// Never persisted anywhere -- see docs/ROAD_ALERTS_DESIGN.md's Privacy
// model section.
const TRAIL_MAX_SAMPLES = 4;
```

- [ ] **Step 3: Add `onRouteIds` state and the trail/weighted-points refs**

Change:

```typescript
  const [hasDetectedMovement, setHasDetectedMovement] = useState(false);
  const [signals, setSignals] = useState<RoadSignal[]>([]);
```

to:

```typescript
  const [hasDetectedMovement, setHasDetectedMovement] = useState(false);
  const [signals, setSignals] = useState<RoadSignal[]>([]);
  // Signal ids findAlertsForWeightedPoints (narrowed by
  // approachedWeightedPoints) most recently matched -- drives both the
  // auto-speak "ahead" override and the "on your route" list tag below.
  const [onRouteIds, setOnRouteIds] = useState<Set<string>>(new Set());
```

Then change:

```typescript
  // The previous GPS fix, used to estimate speed when the device doesn't
  // report GeolocationCoordinates.speed itself (see onPosition below).
  // Reset in handleStart so a stale fix from a prior trip can't be
  // compared against this trip's first one.
  const lastFixRef = useRef<{ latitude: number; longitude: number; timestampMs: number } | null>(null);
```

to:

```typescript
  // The previous GPS fix, used to estimate speed when the device doesn't
  // report GeolocationCoordinates.speed itself (see onPosition below).
  // Reset in handleStart so a stale fix from a prior trip can't be
  // compared against this trip's first one.
  const lastFixRef = useRef<{ latitude: number; longitude: number; timestampMs: number } | null>(null);
  // Short in-memory trail for approachedWeightedPoints -- capped at
  // TRAIL_MAX_SAMPLES, oldest dropped first. Never persisted. Reset in
  // handleStart, same as lastFixRef.
  const trailRef = useRef<TimedCoordinates[]>([]);
  // This account's real, already-qualified weighted points -- populated
  // by refreshRealWeightedPoints below. A ref, not state: nothing here
  // renders directly from it, it's only read inside the long-lived
  // fetchSignals closure.
  const weightedPointsRef = useRef<WeightedPoint[]>([]);
```

- [ ] **Step 4: Actually store the fetched weighted points, and fetch them once on sign-in**

Change:

```typescript
  // One-shot fetch of this account's real, already-qualified weighted
  // points -- re-fetched from pingWeightedPoint below whenever a new ping
  // might have just pushed a point past its qualifying threshold. Not
  // otherwise used on this page yet (unlike ui/mobile's route-matching);
  // fetched here only so a ping's own refresh call has a home and this
  // page's data stays consistent with what pinging is actually building.
  const refreshRealWeightedPoints = useCallback(async () => {
    const current = accountRef.current;
    if (!current) return;
    try {
      await getWeightedPoints({ email: current.email, serviceKey: current.serviceKey });
    } catch {
      // Best-effort -- see pingWeightedPoint's own comment below.
    }
  }, []);
```

to:

```typescript
  // This account's real, already-qualified weighted points, used to
  // narrow (approachedWeightedPoints) and then match
  // (findAlertsForWeightedPoints) hazards against routine destinations --
  // see fetchSignals below. Re-fetched from pingWeightedPoint whenever a
  // new ping might have just pushed a point past its qualifying
  // threshold, so a route that becomes routine *during* this same
  // session is usable without waiting for the next sign-in. Mirrors
  // ui/mobile's RoadAlertsForm.tsx's own refreshRealWeightedPoints.
  const refreshRealWeightedPoints = useCallback(async () => {
    const current = accountRef.current;
    if (!current) return;
    try {
      const response = await getWeightedPoints({ email: current.email, serviceKey: current.serviceKey });
      weightedPointsRef.current = response.weightedPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        weight: p.weight,
        tlid: p.tlid ?? undefined,
      }));
    } catch {
      // Best-effort -- see pingWeightedPoint's own comment below.
    }
  }, []);

  // One-shot fetch as soon as an account is ready -- without this, a
  // fresh sign-in would have an empty weightedPointsRef until the first
  // qualifying ping (WEIGHTED_POINT_PING_INTERVAL_MS into a drive).
  useEffect(() => {
    if (!account) {
      weightedPointsRef.current = [];
      return;
    }
    refreshRealWeightedPoints();
  }, [account, refreshRealWeightedPoints]);
```

- [ ] **Step 5: Narrow and match inside `fetchSignals`, and use the match for auto-speak**

Change:

```typescript
        setSignals(response.signals);
        setPartial(response.partial);
        setError(null);

        for (const signal of response.signals) {
          if (spokenIdsRef.current.has(signal.id)) continue;
          if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') continue;
          const bearing = bearingDegrees(
            { latitude, longitude },
            { latitude: signal.latitude, longitude: signal.longitude }
          );
          const ahead = isAhead(heading, bearing);
          spokenIdsRef.current.add(signal.id);
          if (ahead && shouldAutoSpeak(signal.severity)) {
            speakSignal(signal);
          }
        }
```

to:

```typescript
        setSignals(response.signals);
        setPartial(response.partial);
        setError(null);

        // Which of this account's routine destinations recent movement
        // actually looks like it's heading toward, then which hazards
        // fall between here and one of those -- see
        // docs/superpowers/specs/2026-09-12-road-alerts-route-approach-design.md.
        // A route match is treated as "ahead" unconditionally below: the
        // corridor-to-a-routine-point geometry already proves relevance,
        // so it shouldn't get silently dropped by a momentary bad heading
        // reading (e.g. stopped at a light) the way a plain cone check
        // would. Mirrors ui/mobile's RoadAlertsForm.tsx exactly.
        const candidatePoints = approachedWeightedPoints(trailRef.current, weightedPointsRef.current);
        const routeAlerts = findAlertsForWeightedPoints({ latitude, longitude }, candidatePoints, response.signals);
        const onRouteIds = new Set(routeAlerts.map((a) => a.signal.id));
        setOnRouteIds(onRouteIds);

        for (const signal of response.signals) {
          if (spokenIdsRef.current.has(signal.id)) continue;
          if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') continue;
          const bearing = bearingDegrees(
            { latitude, longitude },
            { latitude: signal.latitude, longitude: signal.longitude }
          );
          const ahead = onRouteIds.has(signal.id) || isAhead(heading, bearing);
          spokenIdsRef.current.add(signal.id);
          if (ahead && shouldAutoSpeak(signal.severity)) {
            speakSignal(signal);
          }
        }
```

- [ ] **Step 6: Append to the trail on the same tick hazards are checked**

Change:

```typescript
      const now = Date.now();
      if (hasDetectedMovementRef.current && now - lastFetchAtRef.current >= POLL_MIN_INTERVAL_MS) {
        lastFetchAtRef.current = now;
        fetchSignals(latitude, longitude, estimatedHeadingDeg);
      }
```

to:

```typescript
      const now = Date.now();
      if (hasDetectedMovementRef.current && now - lastFetchAtRef.current >= POLL_MIN_INTERVAL_MS) {
        lastFetchAtRef.current = now;
        trailRef.current = [...trailRef.current, current].slice(-TRAIL_MAX_SAMPLES);
        fetchSignals(latitude, longitude, estimatedHeadingDeg);
      }
```

(`current` here is the `{ latitude, longitude, timestampMs: pos.timestamp }` object already built earlier in `onPosition` for the speed/heading estimate -- no new variable needed.)

- [ ] **Step 7: Reset the trail and route-match state on every new Start**

Change:

```typescript
    isFirstPositionOfSessionRef.current = true;
    hasDetectedMovementRef.current = false;
    setHasDetectedMovement(false);
    lastFixRef.current = null;
```

to:

```typescript
    isFirstPositionOfSessionRef.current = true;
    hasDetectedMovementRef.current = false;
    setHasDetectedMovement(false);
    lastFixRef.current = null;
    trailRef.current = [];
    setOnRouteIds(new Set());
```

- [ ] **Step 8: Use the match in the rendered list, both for the ahead/behind tag and the new "on your route" tag**

Change:

```typescript
          const ahead =
            position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? isAhead(
                  position.heading,
                  bearingDegrees(
                    { latitude: position.latitude, longitude: position.longitude },
                    { latitude: signal.latitude, longitude: signal.longitude }
                  )
                )
              : true;
```

to:

```typescript
          const onRoute = onRouteIds.has(signal.id);
          const ahead =
            onRoute ||
            (position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? isAhead(
                  position.heading,
                  bearingDegrees(
                    { latitude: position.latitude, longitude: position.longitude },
                    { latitude: signal.latitude, longitude: signal.longitude }
                  )
                )
              : true);
```

Then change:

```typescript
                <span className="card-kicker">
                  {distance !== null ? `${metersLabel(distance)} away` : 'distance unknown'}
                  {!ahead ? ' · behind you' : ''}
                </span>
```

to:

```typescript
                <span className="card-kicker">
                  {distance !== null ? `${metersLabel(distance)} away` : 'distance unknown'}
                  {onRoute ? ' · on your route' : !ahead ? ' · behind you' : ''}
                </span>
```

- [ ] **Step 9: Typecheck and run the existing test suite**

Run: `cd ui/desktop && npx tsc -b --noEmit`
Expected: no output (clean).

Run: `cd ui/desktop && npm test -- --run`
Expected: PASS, 15/15 (no new tests added by this task -- see the task's own Interfaces note).

- [ ] **Step 10: Commit**

```bash
git add ui/desktop/src/pages/RoadAlerts.tsx
git commit -m "Use route-approach matching for desktop's Road Alerts relevance"
```

---

### Task 3: Wire mobile's `RoadAlertsForm.tsx` up to the same narrowing

**Files:**
- Modify: `ui/mobile/components/RoadAlertsForm.tsx`

**Interfaces:**
- Consumes: `approachedWeightedPoints` (Task 1, `../../shared/roadAlertsMatching`); `type TimedCoordinates` (`../../shared/geo`, already exists).
- Produces: nothing new consumed elsewhere -- this task is a leaf.

Mobile already has `onRouteIds` and the "· on your route" tag (unlike desktop, this part isn't new here) -- this task only adds the trail and narrows the existing match through it. No existing test file covers this component; verified by typecheck and a manual click-through.

- [ ] **Step 1: Add the new imports**

Change:

```typescript
import { bearingDegrees, haversineDistanceMeters, isAhead } from '../../shared/geo';
```

to:

```typescript
import { bearingDegrees, haversineDistanceMeters, isAhead } from '../../shared/geo';
import type { TimedCoordinates } from '../../shared/geo';
```

Change:

```typescript
import { findAlertsForWeightedPoints, type WeightedPoint } from '../../shared/roadAlertsMatching';
```

to:

```typescript
import { approachedWeightedPoints, findAlertsForWeightedPoints, type WeightedPoint } from '../../shared/roadAlertsMatching';
```

- [ ] **Step 2: Add the trail-capacity constant**

Find the line defining `POLL_MIN_INTERVAL_MS` (around line 52) and add immediately after it:

```typescript
// How many recent position samples the in-memory route-approach trail
// keeps -- ~60 seconds at the ~15s hazard-check cadence above. Short on
// purpose: a real route change (a turn) should outweigh the pre-turn
// direction quickly. Never persisted anywhere -- see
// docs/ROAD_ALERTS_DESIGN.md's Privacy model section. Mirrors
// ui/desktop/src/pages/RoadAlerts.tsx's own TRAIL_MAX_SAMPLES exactly.
const TRAIL_MAX_SAMPLES = 4;
```

- [ ] **Step 3: Add the trail ref**

Find:

```typescript
  const weightedPointsRef = useRef<WeightedPoint[]>(weightedPoints);
```

and add immediately after it:

```typescript
  // Short in-memory trail for approachedWeightedPoints -- capped at
  // TRAIL_MAX_SAMPLES, oldest dropped first. Never persisted. Reset in
  // handleStart, same as isFirstPositionOfSessionRef.
  const trailRef = useRef<TimedCoordinates[]>([]);
```

- [ ] **Step 4: Narrow through `approachedWeightedPoints` before matching**

Change:

```typescript
        const routeAlerts = findAlertsForWeightedPoints(
          { latitude, longitude },
          weightedPointsRef.current,
          response.signals
        );
```

to:

```typescript
        const candidatePoints = approachedWeightedPoints(trailRef.current, weightedPointsRef.current);
        const routeAlerts = findAlertsForWeightedPoints({ latitude, longitude }, candidatePoints, response.signals);
```

- [ ] **Step 5: Append to the trail on the same tick hazards are checked**

Change:

```typescript
      const now = Date.now();
      if (now - lastFetchAtRef.current >= POLL_MIN_INTERVAL_MS) {
        lastFetchAtRef.current = now;
        fetchSignals(latitude, longitude, heading);
      }
```

to:

```typescript
      const now = Date.now();
      if (now - lastFetchAtRef.current >= POLL_MIN_INTERVAL_MS) {
        lastFetchAtRef.current = now;
        trailRef.current = [...trailRef.current, { latitude, longitude, timestampMs: now }].slice(-TRAIL_MAX_SAMPLES);
        fetchSignals(latitude, longitude, heading);
      }
```

(Mobile's `onPosition` has no existing per-tick timestamp field the way desktop's `pos.timestamp` does -- `location.coords` carries no timestamp of its own at the point this runs, so `Date.now()` -- already computed as `now` on the line above -- is used directly instead.)

- [ ] **Step 6: Reset the trail on every new Start**

Change:

```typescript
      isFirstPositionOfSessionRef.current = true;
      const subscription = await Location.watchPositionAsync(
```

to:

```typescript
      isFirstPositionOfSessionRef.current = true;
      trailRef.current = [];
      const subscription = await Location.watchPositionAsync(
```

- [ ] **Step 7: Typecheck**

Run: `cd ui/mobile && npx tsc --noEmit`
Expected: no output (clean). (`ui/mobile` has no test files at all yet, per `CLAUDE.md` -- typecheck plus a manual click-through, per this task's own Interfaces note, is the full verification here.)

- [ ] **Step 8: Commit**

```bash
git add ui/mobile/components/RoadAlertsForm.tsx
git commit -m "Narrow mobile's route matching by recent movement trend"
```

---

### Task 4: Document the privacy addendum

**Files:**
- Modify: `docs/ROAD_ALERTS_DESIGN.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks -- documentation only.

- [ ] **Step 1: Add the addendum**

Find the end of the Privacy model section in `docs/ROAD_ALERTS_DESIGN.md` -- the bullet list ending with the "Outbound network calls... anonymous by construction" point, immediately before the `### User-facing setting: how much routine is remembered` heading. Insert this new paragraph immediately before that heading:

```markdown
**Addendum, 2026-09-12:** the route-approach matching feature (see
`docs/superpowers/specs/2026-09-12-road-alerts-route-approach-design.md`)
keeps a short (~60 second) trail of recent position fixes, used to infer
which routine destination a driver's current movement looks like it's
heading toward. This does not revisit the "no raw trip trace stored"
decision above -- the trail exists only in the browser/app's own memory
for the current session, is never written to a database or sent to the
server as its own request, and is discarded the moment driving stops or
the page/screen closes.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ROAD_ALERTS_DESIGN.md
git commit -m "Document the route-approach trail as an addendum to the privacy model"
```
