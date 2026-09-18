# Road Alerts Background Push Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `serious`/`need_to_know` Road Alerts hazard reach a driver on iPhone even when the app is fully closed, via Web Push to an installed PWA.

**Architecture:** The desktop app is already an installable PWA (manifest + icons exist) but has no service worker. Add one (push receive only, no offline caching). While driving, the client sends its ephemeral current position to the server (never persisted as history). A new long-running worker process re-runs the existing route-approach matching logic (ported to plain JS, since Node can't `require()` a `.ts` file without a build step) against each active position and the existing hazard cache, and sends a push via `web-push` for any new `serious`/`need_to_know` match.

**Tech Stack:** Node.js/Express (`geocoding-server`), Postgres (`geocoding_users`), `web-push` (npm), React/Vite (`ui/desktop`), plain Service Worker API (no Workbox/`vite-plugin-pwa`).

**Spec:** `docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md`

## Global Constraints

- Desktop web app only (`ui/desktop`) — `ui/mobile` is untouched.
- This is *additional* to PR #62's chime/in-tab notification, never a replacement — a user who never installs the PWA keeps exactly today's behavior.
- The live-position row is **ephemeral**: one row per account, always overwritten (never inserted as new history), deleted on Stop or after **10 minutes** of no update.
- The push-send worker polls on a **60-second** interval (matches `roadSignals.js`'s existing `NETWORK_CACHE_TTL_MS`).
- `web-push`, VAPID keys: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` env vars, unset = feature silently disabled (same convention as `HERE_API_KEY`).
- Every new endpoint uses the existing Road Alerts account-auth pattern: `checkAccess(usersDb, email, serviceKey)` from `roadAlertsAccounts.js`, imported in `server.js` as `checkRoadAlertsAccess`.
- Server-side route-approach matching is a **deliberate, documented duplication** of `ui/shared/roadAlertsMatching.ts`'s `findAlertsForWeightedPoints` (Node has no TypeScript loader here) — same precedent as CLAUDE.md's odd/even house-number rule existing independently in `interpolate.py` and `geocode.js`. A comment in both files must point at the other.
- TDD throughout: `node --test` in `geocoding-server` (throwaway-DB-per-test via `test/helpers.js`'s `withTestServer`), `npm test` (vitest) in `ui/desktop`.

---

### Task 1: Move `shouldStronglyAlert` to `ui/shared`, port matching logic to `geocoding-server`

**Files:**
- Modify: `ui/shared/roadAlertsMatching.ts`
- Modify: `ui/shared/roadAlertsMatching.test.ts`
- Modify: `ui/desktop/src/pages/RoadAlerts.tsx` (import instead of local definition)
- Create: `geocoding-server/src/roadAlertsMatching.js`
- Create: `geocoding-server/test/roadAlertsMatching.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `shouldStronglyAlert(severity: RoadSignalSeverity): boolean` exported from `ui/shared/roadAlertsMatching.ts`. `findAlertsForWeightedPoints(user, weightedPoints, signals, options)` and `shouldStronglyAlert(severity)` exported from `geocoding-server/src/roadAlertsMatching.js`, both consumed directly by Task 5's `runPushCheckOnce` (see its own Step 3 code, which calls `shouldStronglyAlert(alert.signal.severity)` — no separate Set type is needed or consumed anywhere in this plan).

- [ ] **Step 1: Write the failing test for the moved `shouldStronglyAlert`**

Add to `ui/shared/roadAlertsMatching.test.ts` (near the top, alongside the existing `import`s — add `shouldStronglyAlert` to the existing `import { ... } from './roadAlertsMatching'` line):

```ts
describe('shouldStronglyAlert', () => {
  it('is true only for serious and need_to_know', () => {
    expect(shouldStronglyAlert('serious')).toBe(true);
    expect(shouldStronglyAlert('need_to_know')).toBe(true);
    expect(shouldStronglyAlert('proximity')).toBe(false);
    expect(shouldStronglyAlert('fun_to_know')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui/desktop && npx vitest run ../shared/roadAlertsMatching.test.ts`
Expected: FAIL — `shouldStronglyAlert is not exported` / `is not defined`.

- [ ] **Step 3: Add `shouldStronglyAlert` to `ui/shared/roadAlertsMatching.ts`**

Add near the top of the file, after the existing imports (needs `RoadSignalSeverity` added to the existing `import type { Coordinates, RoadSignal } from './api/types';` line — change it to `import type { Coordinates, RoadSignal, RoadSignalSeverity } from './api/types';`):

```ts
/**
 * Plain speech alone is easy to miss (muted, a background tab, not
 * paying attention) -- the chime + browser-notification treatment is
 * reserved for the tiers that actually matter enough to interrupt
 * someone over. `proximity` still auto-speaks but doesn't get the
 * stronger treatment. Moved here (was ui/desktop/src/pages/RoadAlerts.tsx
 * only) so the server-side push-matching worker (see
 * geocoding-server/src/roadAlertsMatching.js) uses the exact same
 * definition as the client.
 */
export function shouldStronglyAlert(severity: RoadSignalSeverity): boolean {
  return severity === 'serious' || severity === 'need_to_know';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui/desktop && npx vitest run ../shared/roadAlertsMatching.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the local definition from `RoadAlerts.tsx` and import the shared one**

In `ui/desktop/src/pages/RoadAlerts.tsx`, delete this block (currently right after `shouldAutoSpeak`):

```tsx
// Plain speech alone is easy to miss (muted, a background tab, not
// paying attention) -- the chime + browser-notification treatment
// (roadAlertNotifications.ts) is reserved for the tiers that actually
// matter enough to interrupt someone over. `proximity` still auto-speaks
// (shouldAutoSpeak above) but doesn't get the stronger treatment.
function shouldStronglyAlert(severity: RoadSignalSeverity): boolean {
  return severity === 'serious' || severity === 'need_to_know';
}
```

Add `shouldStronglyAlert` to the existing shared import (line 29):

```tsx
import {
  approachedWeightedPoints,
  findAlertsForWeightedPoints,
  shouldStronglyAlert,
  type WeightedPoint,
} from '../../../shared/roadAlertsMatching';
```

- [ ] **Step 6: Run the desktop test suite to confirm nothing broke**

Run: `cd ui/desktop && npm test`
Expected: PASS, same count as before.

- [ ] **Step 7: Write the failing test for the server-side port**

Create `geocoding-server/test/roadAlertsMatching.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { findAlertsForWeightedPoints, shouldStronglyAlert } = require('../src/roadAlertsMatching');

// Real Portland, ME coordinates, mirroring ui/shared/roadAlertsMatching.test.ts's own USER constant.
const USER = { latitude: 43.6591, longitude: -70.2568 };
const METERS_PER_DEGREE_LAT = 111320;

function offsetMeters(origin, northMeters, eastMeters) {
  const latitude = origin.latitude + northMeters / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  const longitude = origin.longitude + eastMeters / metersPerDegreeLon;
  return { latitude, longitude };
}

function makeSignal(coords, overrides = {}) {
  return {
    id: overrides.id || 'signal-1',
    latitude: coords.latitude,
    longitude: coords.longitude,
    severity: overrides.severity || 'serious',
    ...overrides,
  };
}

test('findAlertsForWeightedPoints matches a hazard sitting between the user and a routine point', () => {
  const point = { ...offsetMeters(USER, 2000, 0), weight: 5 };
  const hazard = offsetMeters(USER, 1000, 0); // halfway along the path, on it
  const signal = makeSignal(hazard);

  const alerts = findAlertsForWeightedPoints(USER, [point], [signal]);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].signal.id, 'signal-1');
});

test('findAlertsForWeightedPoints does not match a hazard far off the corridor', () => {
  const point = { ...offsetMeters(USER, 2000, 0), weight: 5 };
  const hazard = offsetMeters(USER, 1000, 5000); // 5km east of the path
  const signal = makeSignal(hazard);

  const alerts = findAlertsForWeightedPoints(USER, [point], [signal]);

  assert.equal(alerts.length, 0);
});

test('shouldStronglyAlert is true only for serious and need_to_know', () => {
  assert.equal(shouldStronglyAlert('serious'), true);
  assert.equal(shouldStronglyAlert('need_to_know'), true);
  assert.equal(shouldStronglyAlert('proximity'), false);
  assert.equal(shouldStronglyAlert('fun_to_know'), false);
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `cd geocoding-server && node --test test/roadAlertsMatching.test.js`
Expected: FAIL — `Cannot find module '../src/roadAlertsMatching'`.

- [ ] **Step 9: Create `geocoding-server/src/roadAlertsMatching.js`**

```js
// Plain-JS port of ui/shared/roadAlertsMatching.ts's findAlertsForWeightedPoints
// and shouldStronglyAlert, for the background push-matching worker
// (scripts/road-alerts-push-worker.js) -- Node has no TypeScript loader
// here, so this can't require() the .ts file directly. This is a
// deliberate, documented duplication: if the matching algorithm in
// ui/shared/roadAlertsMatching.ts changes, mirror the change here too.
// Same precedent as CLAUDE.md's odd/even house-number rule existing
// independently in geocoding/interpolate.py and geocoding-server/src/geocode.js.
//
// Only findAlertsForWeightedPoints is ported (not approachedWeightedPoints):
// the worker has a single ephemeral point per account, not a GPS trail, so
// trail-based directional narrowing has nothing to operate on -- feeding a
// single point to approachedWeightedPoints would just fall through to its
// own "not enough trail signal, return everything unfiltered" branch, so
// skipping it entirely and going straight to the geometric corridor check
// is equivalent, not a simplification of behavior.

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two points, in meters. */
function haversineDistanceMeters(a, b) {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from `a` to `b`, in degrees [0, 360), true north. */
function bearingDegrees(a, b) {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

function angularCrossTrack(user, point, target) {
  const angularDistanceToTarget = haversineDistanceMeters(user, target) / EARTH_RADIUS_METERS;
  const bearingToTarget = toRadians(bearingDegrees(user, target));
  const bearingToPoint = toRadians(bearingDegrees(user, point));
  return Math.asin(Math.sin(angularDistanceToTarget) * Math.sin(bearingToTarget - bearingToPoint));
}

function angularAlongTrack(user, point, target) {
  const angularDistanceToTarget = haversineDistanceMeters(user, target) / EARTH_RADIUS_METERS;
  const crossTrack = angularCrossTrack(user, point, target);
  const ratio = Math.cos(angularDistanceToTarget) / Math.cos(crossTrack);
  const magnitude = Math.acos(Math.min(1, Math.max(-1, ratio)));

  const bearingToTarget = toRadians(bearingDegrees(user, target));
  const bearingToPoint = toRadians(bearingDegrees(user, point));
  const isForward = Math.cos(bearingToTarget - bearingToPoint) >= 0;
  return isForward ? magnitude : -magnitude;
}

function crossTrackDistanceMeters(user, point, target) {
  return Math.abs(angularCrossTrack(user, point, target)) * EARTH_RADIUS_METERS;
}

function alongTrackDistanceMeters(user, point, target) {
  return angularAlongTrack(user, point, target) * EARTH_RADIUS_METERS;
}

const DEFAULT_MATCH_OPTIONS = {
  minWeight: 0,
  corridorMeters: 300,
  maxPointDistanceMeters: 10000,
};

function hazardBetweenUserAndPoint(user, point, target, corridorMeters = DEFAULT_MATCH_OPTIONS.corridorMeters) {
  const pathDistanceMeters = haversineDistanceMeters(user, point);
  if (pathDistanceMeters === 0) return false;
  if (crossTrackDistanceMeters(user, point, target) > corridorMeters) return false;
  const alongTrack = alongTrackDistanceMeters(user, point, target);
  return alongTrack >= 0 && alongTrack <= pathDistanceMeters;
}

/** Mirrors ui/shared/roadAlertsMatching.ts's findAlertsForWeightedPoints exactly -- see the module comment above. */
function findAlertsForWeightedPoints(user, weightedPoints, signals, options = {}) {
  const { minWeight, corridorMeters, maxPointDistanceMeters } = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const triggeredBySignalId = new Map();

  for (const point of weightedPoints) {
    if (point.weight < minWeight) continue;
    if (haversineDistanceMeters(user, point) > maxPointDistanceMeters) continue;

    for (const signal of signals) {
      if (triggeredBySignalId.has(signal.id)) continue;
      if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') continue;
      const target = { latitude: signal.latitude, longitude: signal.longitude };
      if (!hazardBetweenUserAndPoint(user, point, target, corridorMeters)) continue;

      triggeredBySignalId.set(signal.id, {
        signal,
        matchedPoint: point,
        distanceAlongPathMeters: alongTrackDistanceMeters(user, point, target),
      });
    }
  }

  return [...triggeredBySignalId.values()];
}

/** Mirrors ui/shared/roadAlertsMatching.ts's shouldStronglyAlert exactly -- see the module comment above. */
function shouldStronglyAlert(severity) {
  return severity === 'serious' || severity === 'need_to_know';
}

module.exports = {
  findAlertsForWeightedPoints,
  shouldStronglyAlert,
  hazardBetweenUserAndPoint,
  crossTrackDistanceMeters,
  alongTrackDistanceMeters,
};
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd geocoding-server && node --test test/roadAlertsMatching.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 11: Add a cross-reference comment to the client-side original**

In `ui/shared/roadAlertsMatching.ts`, add above `findAlertsForWeightedPoints`'s existing docstring:

```ts
// Mirrored (not imported -- Node has no TypeScript loader) at
// geocoding-server/src/roadAlertsMatching.js's findAlertsForWeightedPoints.
// Keep both in sync if this logic changes.
```

- [ ] **Step 12: Commit**

```bash
git add ui/shared/roadAlertsMatching.ts ui/shared/roadAlertsMatching.test.ts \
  ui/desktop/src/pages/RoadAlerts.tsx \
  geocoding-server/src/roadAlertsMatching.js geocoding-server/test/roadAlertsMatching.test.js
git commit -m "Move shouldStronglyAlert to ui/shared, port matching logic server-side"
```

---

### Task 2: Database tables for push subscriptions, live position, and dedup

**Files:**
- Create: `geocoding-server/src/roadAlertsPush.js`
- Create: `geocoding-server/test/roadAlertsPush.test.js`

**Interfaces:**
- Consumes: `roadAlertsAccounts.js`'s `registerAccount(pool, email)` (for tests, to get an `account.id`).
- Produces (used by Tasks 3-5): `ensureRoadAlertsPushTables(pool)`, `saveSubscription(pool, accountId, subscription)`, `getSubscriptionsForAccount(pool, accountId)`, `deleteSubscriptionByEndpoint(pool, endpoint)`, `upsertLivePosition(pool, accountId, { latitude, longitude, heading })`, `deleteLivePosition(pool, accountId)`, `getActiveLivePositions(pool)` (returns rows with `account_id`, `email`, `latitude`, `longitude`, `heading`, joined against `road_alerts_accounts`, filtered to `updated_at > now() - interval '10 minutes'`), `hasAlreadySentPush(pool, accountId, signalId)`, `recordPushSent(pool, accountId, signalId)`, `clearPushSentForAccount(pool, accountId)`.

- [ ] **Step 1: Write the failing test**

Create `geocoding-server/test/roadAlertsPush.test.js`. Uses `makeUsersDb()` (from `test/helpers.js` — returns a throwaway-database-backed pool with an explicit `.close()`, the same helper `roadAlertsAccounts.test.js` uses directly, not `withTestServer`, since these tests exercise the DB functions directly with no HTTP layer involved):

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const { registerAccount, ensureRoadAlertsAccountsTable } = require('../src/roadAlertsAccounts');
const {
  ensureRoadAlertsPushTables,
  saveSubscription,
  getSubscriptionsForAccount,
  deleteSubscriptionByEndpoint,
  upsertLivePosition,
  deleteLivePosition,
  getActiveLivePositions,
  hasAlreadySentPush,
  recordPushSent,
  clearPushSentForAccount,
} = require('../src/roadAlertsPush');

async function setUp(pool) {
  await ensureRoadAlertsAccountsTable(pool);
  await ensureRoadAlertsPushTables(pool);
  return registerAccount(pool, 'driver@example.com');
}

test('saveSubscription is idempotent for the same account+endpoint', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  const subscription = { endpoint: 'https://push.example/abc', p256dh: 'key1', auth: 'auth1' };

  await saveSubscription(pool, account.id, subscription);
  await saveSubscription(pool, account.id, subscription);

  const rows = await getSubscriptionsForAccount(pool, account.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, subscription.endpoint);
  await pool.close();
});

test('deleteSubscriptionByEndpoint removes only that subscription', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/a', p256dh: 'k', auth: 'a' });
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/b', p256dh: 'k', auth: 'a' });

  await deleteSubscriptionByEndpoint(pool, 'https://push.example/a');

  const rows = await getSubscriptionsForAccount(pool, account.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, 'https://push.example/b');
  await pool.close();
});

test('upsertLivePosition overwrites in place, never inserts a second row', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);

  await upsertLivePosition(pool, account.id, { latitude: 43.6, longitude: -70.2, heading: 90 });
  await upsertLivePosition(pool, account.id, { latitude: 43.7, longitude: -70.3, heading: 180 });

  const active = await getActiveLivePositions(pool);
  const mine = active.filter((row) => row.account_id === account.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].latitude, 43.7);
  assert.equal(mine[0].email, 'driver@example.com');
  await pool.close();
});

test('deleteLivePosition removes the row so it no longer appears as active', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  await upsertLivePosition(pool, account.id, { latitude: 43.6, longitude: -70.2, heading: null });

  await deleteLivePosition(pool, account.id);

  const active = await getActiveLivePositions(pool);
  assert.equal(active.filter((row) => row.account_id === account.id).length, 0);
  await pool.close();
});

test('a stale live position (older than 10 minutes) is excluded from getActiveLivePositions', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);
  await upsertLivePosition(pool, account.id, { latitude: 43.6, longitude: -70.2, heading: null });
  await pool.query(
    `UPDATE road_alerts_live_positions SET updated_at = now() - interval '11 minutes' WHERE account_id = $1`,
    [account.id]
  );

  const active = await getActiveLivePositions(pool);
  assert.equal(active.filter((row) => row.account_id === account.id).length, 0);
  await pool.close();
});

test('hasAlreadySentPush / recordPushSent / clearPushSentForAccount', async () => {
  const pool = await makeUsersDb();
  const account = await setUp(pool);

  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), false);

  await recordPushSent(pool, account.id, 'signal-1');
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), true);
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-2'), false);

  await clearPushSentForAccount(pool, account.id);
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), false);
  await pool.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd geocoding-server && node --test test/roadAlertsPush.test.js`
Expected: FAIL — `Cannot find module '../src/roadAlertsPush'`.

- [ ] **Step 3: Create `geocoding-server/src/roadAlertsPush.js`**

```js
const CREATE_PUSH_SUBSCRIPTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES road_alerts_accounts(id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, endpoint)
);
`;

// account_id as the PRIMARY KEY (not a surrogate id) is what makes "one
// row per account, always overwritten" structural rather than a
// convention to remember -- see docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
const CREATE_LIVE_POSITIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_live_positions (
  account_id BIGINT PRIMARY KEY REFERENCES road_alerts_accounts(id),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  heading DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const CREATE_PUSH_SENT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS road_alerts_push_sent (
  account_id BIGINT NOT NULL REFERENCES road_alerts_accounts(id),
  signal_id TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, signal_id)
);
`;

async function ensureRoadAlertsPushTables(pool) {
  await pool.query(CREATE_PUSH_SUBSCRIPTIONS_TABLE_SQL);
  await pool.query(CREATE_LIVE_POSITIONS_TABLE_SQL);
  await pool.query(CREATE_PUSH_SENT_TABLE_SQL);
}

/** Idempotent -- re-subscribing with the same endpoint (e.g. after a browser data clear) is a no-op, not a duplicate row. */
async function saveSubscription(pool, accountId, { endpoint, p256dh, auth }) {
  await pool.query(
    `INSERT INTO road_alerts_push_subscriptions (account_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, endpoint) DO NOTHING`,
    [accountId, endpoint, p256dh, auth]
  );
}

async function getSubscriptionsForAccount(pool, accountId) {
  const { rows } = await pool.query('SELECT * FROM road_alerts_push_subscriptions WHERE account_id = $1', [
    accountId,
  ]);
  return rows;
}

/** Called when a push send comes back 410 Gone -- the browser unsubscribed, unrecoverable. */
async function deleteSubscriptionByEndpoint(pool, endpoint) {
  await pool.query('DELETE FROM road_alerts_push_subscriptions WHERE endpoint = $1', [endpoint]);
}

/** Upsert, not insert -- account_id is the primary key, so this always overwrites the single existing row for this account. */
async function upsertLivePosition(pool, accountId, { latitude, longitude, heading }) {
  await pool.query(
    `INSERT INTO road_alerts_live_positions (account_id, latitude, longitude, heading, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (account_id) DO UPDATE
       SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, heading = EXCLUDED.heading, updated_at = now()`,
    [accountId, latitude, longitude, heading ?? null]
  );
}

async function deleteLivePosition(pool, accountId) {
  await pool.query('DELETE FROM road_alerts_live_positions WHERE account_id = $1', [accountId]);
}

/** Only rows updated in the last 10 minutes -- an older row is treated as a driver who never called Stop cleanly. Joined against road_alerts_accounts for the email the worker needs to look up weighted points. */
async function getActiveLivePositions(pool) {
  const { rows } = await pool.query(
    `SELECT lp.account_id, a.email, lp.latitude, lp.longitude, lp.heading, lp.updated_at
     FROM road_alerts_live_positions lp
     JOIN road_alerts_accounts a ON a.id = lp.account_id
     WHERE lp.updated_at > now() - interval '10 minutes'`
  );
  return rows;
}

async function hasAlreadySentPush(pool, accountId, signalId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM road_alerts_push_sent WHERE account_id = $1 AND signal_id = $2',
    [accountId, signalId]
  );
  return rows.length > 0;
}

async function recordPushSent(pool, accountId, signalId) {
  await pool.query(
    `INSERT INTO road_alerts_push_sent (account_id, signal_id) VALUES ($1, $2)
     ON CONFLICT (account_id, signal_id) DO NOTHING`,
    [accountId, signalId]
  );
}

/** Clears this account's dedup history -- called when its live-position row is deleted/expired, so a later drive starts clean and the same hazard can alert again. */
async function clearPushSentForAccount(pool, accountId) {
  await pool.query('DELETE FROM road_alerts_push_sent WHERE account_id = $1', [accountId]);
}

module.exports = {
  ensureRoadAlertsPushTables,
  saveSubscription,
  getSubscriptionsForAccount,
  deleteSubscriptionByEndpoint,
  upsertLivePosition,
  deleteLivePosition,
  getActiveLivePositions,
  hasAlreadySentPush,
  recordPushSent,
  clearPushSentForAccount,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd geocoding-server && node --test test/roadAlertsPush.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add geocoding-server/src/roadAlertsPush.js geocoding-server/test/roadAlertsPush.test.js
git commit -m "Add push subscription, live-position, and dedup tables"
```

---

### Task 3: VAPID key config, `web-push` dependency, public-key endpoint

**Files:**
- Modify: `geocoding-server/package.json` (add `web-push` dependency)
- Create: `geocoding-server/src/pushKeys.js`
- Create: `geocoding-server/test/pushKeys.test.js`
- Modify: `geocoding-server/src/server.js` (new `GET /road-signals/push-public-key`)
- Create: `geocoding-server/test/pushPublicKeyEndpoint.test.js`

**Interfaces:**
- Consumes: `process.env.VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`.
- Produces: `isPushConfigured()`, `getVapidPublicKey()`, `configureWebPush(webPushModule)` (call once at server/worker startup to call `webPushModule.setVapidDetails(...)`) from `geocoding-server/src/pushKeys.js`. `GET /road-signals/push-public-key` → `{ publicKey: string }` (200) or `{ error }` (404) when unconfigured.

- [ ] **Step 1: Add the dependency**

```bash
cd geocoding-server && npm install web-push
```

- [ ] **Step 2: Write the failing test for `pushKeys.js`**

Create `geocoding-server/test/pushKeys.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('isPushConfigured is false when env vars are unset', () => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  delete require.cache[require.resolve('../src/pushKeys')];
  const { isPushConfigured } = require('../src/pushKeys');
  assert.equal(isPushConfigured(), false);
});

test('isPushConfigured is true and getVapidPublicKey returns it once all three env vars are set', () => {
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  delete require.cache[require.resolve('../src/pushKeys')];
  const { isPushConfigured, getVapidPublicKey } = require('../src/pushKeys');
  assert.equal(isPushConfigured(), true);
  assert.equal(getVapidPublicKey(), 'test-public-key');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd geocoding-server && node --test test/pushKeys.test.js`
Expected: FAIL — `Cannot find module '../src/pushKeys'`.

- [ ] **Step 4: Create `geocoding-server/src/pushKeys.js`**

```js
// Web Push (see scripts/road-alerts-push-worker.js) needs all three of
// these to send anything -- unset = feature silently disabled, same
// "unset = disabled" convention as HERE_API_KEY (see CLAUDE.md). Read
// fresh on every call (not cached at module-load time) so tests can
// change process.env and re-require this module to see the change.
function isPushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY;
}

/** Call once at process startup (server.js and the push worker both need this) before sending any push. */
function configureWebPush(webPushModule) {
  if (!isPushConfigured()) return;
  webPushModule.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

module.exports = { isPushConfigured, getVapidPublicKey, configureWebPush };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd geocoding-server && node --test test/pushKeys.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Write the failing test for the endpoint**

Create `geocoding-server/test/pushPublicKeyEndpoint.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

test('GET /road-signals/push-public-key returns 404 when unconfigured', () =>
  withTestServer(
    async ({ port }) => {
      delete process.env.VAPID_PUBLIC_KEY;
      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-public-key`);
      assert.equal(response.status, 404);
    },
    { seedStreets: false }
  ));

test('GET /road-signals/push-public-key returns the key when configured', () =>
  withTestServer(
    async ({ port }) => {
      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = 'test-private-key';
      process.env.VAPID_SUBJECT = 'mailto:test@example.com';
      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-public-key`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.publicKey, 'test-public-key');
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      delete process.env.VAPID_SUBJECT;
    },
    { seedStreets: false }
  ));
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd geocoding-server && node --test test/pushPublicKeyEndpoint.test.js`
Expected: FAIL — 404 on both (route doesn't exist yet), so the second test's `assert.equal(response.status, 200)` fails.

- [ ] **Step 8: Add the endpoint to `server.js`**

Add near the other `/road-signals/*` routes (after the existing `/road-signals/reroute` handler), and add `const { isPushConfigured, getVapidPublicKey } = require('./pushKeys');` alongside this file's other top-level `require`s:

```js
// Unauthenticated on purpose -- a VAPID public key is not a secret (it's
// sent to the browser's push service on every subscribe by design), and
// exposing it this way means the frontend doesn't need a rebuild if the
// key is ever rotated.
app.get('/road-signals/push-public-key', (req, res) => {
  if (!isPushConfigured()) {
    return res.status(404).json({ error: 'push notifications are not configured on this server' });
  }
  res.json({ publicKey: getVapidPublicKey() });
});
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd geocoding-server && node --test test/pushPublicKeyEndpoint.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 10: Commit**

```bash
git add geocoding-server/package.json geocoding-server/package-lock.json \
  geocoding-server/src/pushKeys.js geocoding-server/test/pushKeys.test.js \
  geocoding-server/src/server.js geocoding-server/test/pushPublicKeyEndpoint.test.js
git commit -m "Add VAPID key config and GET /road-signals/push-public-key"
```

---

### Task 4: Push-subscribe and live-position endpoints

**Files:**
- Modify: `geocoding-server/src/server.js`
- Create: `geocoding-server/test/pushSubscribeEndpoint.test.js`
- Create: `geocoding-server/test/livePositionEndpoint.test.js`

**Interfaces:**
- Consumes: `saveSubscription`/`upsertLivePosition`/`deleteLivePosition`/`clearPushSentForAccount` (Task 2), `checkRoadAlertsAccess` (existing).
- Produces: `POST /road-signals/push-subscribe`, `POST /road-signals/live-position`, `DELETE /road-signals/live-position`.

- [ ] **Step 1: Write the failing tests**

Create `geocoding-server/test/pushSubscribeEndpoint.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');
const { registerAccount } = require('../src/roadAlertsAccounts');

test('POST /road-signals/push-subscribe stores a subscription for a valid account', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const account = await registerAccount(usersDb, 'driver@example.com');

      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: account.service_key,
          subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } },
        }),
      });

      assert.equal(response.status, 200);
      const { rows } = await usersDb.query('SELECT * FROM road_alerts_push_subscriptions WHERE account_id = $1', [
        account.id,
      ]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].endpoint, 'https://push.example/abc');
    },
    { seedStreets: false }
  ));

test('POST /road-signals/push-subscribe rejects a wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerAccount(usersDb, 'driver@example.com');

      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: 'wrong-key',
          subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } },
        }),
      });

      assert.equal(response.status, 401);
    },
    { seedStreets: false }
  ));
```

Create `geocoding-server/test/livePositionEndpoint.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');
const { registerAccount } = require('../src/roadAlertsAccounts');

test('POST then DELETE /road-signals/live-position round-trips correctly', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const account = await registerAccount(usersDb, 'driver@example.com');

      const post = await fetch(`http://127.0.0.1:${port}/road-signals/live-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: account.service_key,
          latitude: 43.65,
          longitude: -70.25,
          heading: 90,
        }),
      });
      assert.equal(post.status, 200);

      const { rows: afterPost } = await usersDb.query(
        'SELECT * FROM road_alerts_live_positions WHERE account_id = $1',
        [account.id]
      );
      assert.equal(afterPost.length, 1);

      const del = await fetch(
        `http://127.0.0.1:${port}/road-signals/live-position?email=driver@example.com&serviceKey=${account.service_key}`,
        { method: 'DELETE' }
      );
      assert.equal(del.status, 200);

      const { rows: afterDelete } = await usersDb.query(
        'SELECT * FROM road_alerts_live_positions WHERE account_id = $1',
        [account.id]
      );
      assert.equal(afterDelete.length, 0);
    },
    { seedStreets: false }
  ));

test('POST /road-signals/live-position rejects a non-numeric latitude', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const account = await registerAccount(usersDb, 'driver@example.com');

      const response = await fetch(`http://127.0.0.1:${port}/road-signals/live-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'driver@example.com',
          serviceKey: account.service_key,
          latitude: 'not-a-number',
          longitude: -70.25,
        }),
      });

      assert.equal(response.status, 400);
    },
    { seedStreets: false }
  ));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd geocoding-server && node --test test/pushSubscribeEndpoint.test.js test/livePositionEndpoint.test.js`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Add the endpoints to `server.js`**

Add near the push-public-key endpoint from Task 3. Requires `const { saveSubscription, upsertLivePosition, deleteLivePosition, clearPushSentForAccount } = require('./roadAlertsPush');` added alongside this file's other top-level `require`s:

```js
// Stores a browser's Web Push subscription against its Road Alerts
// account -- see docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
// Same account-auth gate as every other Road Alerts account-scoped
// endpoint (checkRoadAlertsAccess).
app.post('/road-signals/push-subscribe', async (req, res) => {
  const { email, serviceKey, subscription } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }
    if (
      !subscription ||
      typeof subscription.endpoint !== 'string' ||
      !subscription.keys ||
      typeof subscription.keys.p256dh !== 'string' ||
      typeof subscription.keys.auth !== 'string'
    ) {
      throw new ValidationError('subscription must include endpoint and keys.p256dh/keys.auth');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
    await saveSubscription(usersDb, account.id, {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });
    res.json({ subscribed: true });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Ephemeral -- see the spec's Privacy model section. One row per
// account, always overwritten, never a history table.
app.post('/road-signals/live-position', async (req, res) => {
  const { email, serviceKey, latitude, longitude, heading } = req.body || {};
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }
    if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
      throw new ValidationError('latitude must be a number');
    }
    if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
      throw new ValidationError('longitude must be a number');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
    await upsertLivePosition(usersDb, account.id, {
      latitude,
      longitude,
      heading: typeof heading === 'number' && !Number.isNaN(heading) ? heading : null,
    });
    res.json({ updated: true });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Called on Stop -- removes the row immediately rather than waiting for
// the worker's 10-minute staleness timeout, and clears this account's
// push-dedup history so the same hazard can alert again on a later trip.
app.delete('/road-signals/live-position', async (req, res) => {
  const { email, serviceKey } = req.query;
  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
      throw new ValidationError('serviceKey must be a non-empty string');
    }

    const usersDb = await usersDbPromise;
    const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
    await deleteLivePosition(usersDb, account.id);
    await clearPushSentForAccount(usersDb, account.id);
    res.json({ deleted: true });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd geocoding-server && node --test test/pushSubscribeEndpoint.test.js test/livePositionEndpoint.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full server test suite**

Run: `cd geocoding-server && node --test`
Expected: PASS, same pre-existing skip count as before (see CLAUDE.md), no new failures.

- [ ] **Step 6: Commit**

```bash
git add geocoding-server/src/server.js geocoding-server/test/pushSubscribeEndpoint.test.js geocoding-server/test/livePositionEndpoint.test.js
git commit -m "Add push-subscribe and live-position endpoints"
```

---

### Task 5: Matching + push-send worker script

**Files:**
- Create: `geocoding-server/scripts/road-alerts-push-worker.js` (exports its own dependency-injectable `runPushCheckOnce`, testable without a real timer — no changes to `roadAlertsPush.js` are needed, all its functions this task consumes already exist from Task 2)
- Create: `geocoding-server/test/roadAlertsPushWorker.test.js`
- Create: `ops/geocoding-road-alerts-push-worker.service`

**Interfaces:**
- Consumes: `getActiveLivePositions`, `hasAlreadySentPush`, `recordPushSent`, `clearPushSentForAccount`, `getSubscriptionsForAccount`, `deleteSubscriptionByEndpoint` (Task 2); `findAlertsForWeightedPoints`, `shouldStronglyAlert` (Task 1); `getWeightedPoints` (existing, `weightedPoints.js`); `getRoadSignals` (existing, `roadSignals.js`); `configureWebPush`, `isPushConfigured` (Task 3); `web-push`'s `sendNotification(subscription, payload)`.
- Produces: `runPushCheckOnce(pool, { getRoadSignals, getWeightedPoints, webPush })` (dependency-injected for testing) exported from the worker script.

- [ ] **Step 1: Write the failing test**

Create `geocoding-server/test/roadAlertsPushWorker.test.js`. Uses `makeUsersDb()` directly, same reasoning as Task 2's tests:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const { registerAccount, ensureRoadAlertsAccountsTable } = require('../src/roadAlertsAccounts');
const { ensureWeightedPointsTable, recordWeightedPointPing } = require('../src/weightedPoints');
const {
  ensureRoadAlertsPushTables,
  saveSubscription,
  upsertLivePosition,
  hasAlreadySentPush,
  recordPushSent,
  getSubscriptionsForAccount,
} = require('../src/roadAlertsPush');
const { runPushCheckOnce } = require('../scripts/road-alerts-push-worker');

async function setUp(pool) {
  await ensureRoadAlertsAccountsTable(pool);
  await ensureWeightedPointsTable(pool);
  await ensureRoadAlertsPushTables(pool);
}

test('runPushCheckOnce sends a push for a serious hazard matched to an active driver', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/abc', p256dh: 'k', auth: 'a' });
  // A routine point 2km north of the driver's live position.
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const sent = [];
  const fakeWebPush = {
    sendNotification: async (subscription, payload) => {
      sent.push({ subscription, payload });
    },
  };
  const fakeGetRoadSignals = async () => ({
    signals: [
      {
        id: 'signal-1',
        severity: 'serious',
        latitude: 43.668, // ~1km along the path north -- inside the corridor
        longitude: -70.2568,
        speech: { brief: 'Serious hazard ahead' },
      },
    ],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscription.endpoint, 'https://push.example/abc');
  assert.equal(await hasAlreadySentPush(pool, account.id, 'signal-1'), true);
  await pool.close();
});

test('runPushCheckOnce does not re-send a hazard already recorded as sent', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/abc', p256dh: 'k', auth: 'a' });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });
  await recordPushSent(pool, account.id, 'signal-1');

  const sent = [];
  const fakeWebPush = { sendNotification: async (subscription, payload) => sent.push({ subscription, payload }) };
  const fakeGetRoadSignals = async () => ({
    signals: [{ id: 'signal-1', severity: 'serious', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } }],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  assert.equal(sent.length, 0);
  await pool.close();
});

test('runPushCheckOnce deletes a subscription on a 410 Gone response', async () => {
  const pool = await makeUsersDb();
  await setUp(pool);
  const account = await registerAccount(pool, 'driver@example.com');
  await saveSubscription(pool, account.id, { endpoint: 'https://push.example/expired', p256dh: 'k', auth: 'a' });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await recordWeightedPointPing(pool, 'driver@example.com', {
    latitude: 43.677,
    longitude: -70.2568,
    isEndpoint: false,
    routineDensity: 'balanced',
  });
  await upsertLivePosition(pool, account.id, { latitude: 43.6591, longitude: -70.2568, heading: null });

  const fakeWebPush = {
    sendNotification: async () => {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    },
  };
  const fakeGetRoadSignals = async () => ({
    signals: [{ id: 'signal-1', severity: 'serious', latitude: 43.668, longitude: -70.2568, speech: { brief: 'x' } }],
    networks: [],
    partial: false,
    failedNetworks: [],
    generatedAt: new Date().toISOString(),
  });

  await runPushCheckOnce(pool, { getRoadSignals: fakeGetRoadSignals, webPush: fakeWebPush });

  const remaining = await getSubscriptionsForAccount(pool, account.id);
  assert.equal(remaining.length, 0);
  await pool.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd geocoding-server && node --test test/roadAlertsPushWorker.test.js`
Expected: FAIL — `Cannot find module '../scripts/road-alerts-push-worker'`.

- [ ] **Step 3: Create `geocoding-server/scripts/road-alerts-push-worker.js`**

```js
#!/usr/bin/env node
// Long-running process (not a systemd-timer-triggered one-shot, unlike
// scripts/road-alerts-digest.js) -- runs its own setInterval every 60s
// (matches roadSignals.js's NETWORK_CACHE_TTL_MS), since it may be the
// only thing still requesting hazard data once every browser tab is
// closed. See ops/geocoding-road-alerts-push-worker.service and
// docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
//
//   node scripts/road-alerts-push-worker.js

require('dotenv').config();

const { Pool } = require('../src/db');
const { getRoadSignals: realGetRoadSignals } = require('../src/roadSignals');
const { getWeightedPoints: realGetWeightedPoints } = require('../src/weightedPoints');
const { ensureWeightedPointsTable } = require('../src/weightedPoints');
const { ensureRoadAlertsAccountsTable } = require('../src/roadAlertsAccounts');
const {
  ensureRoadAlertsPushTables,
  getActiveLivePositions,
  hasAlreadySentPush,
  recordPushSent,
  clearPushSentForAccount,
  getSubscriptionsForAccount,
  deleteSubscriptionByEndpoint,
} = require('../src/roadAlertsPush');
const { findAlertsForWeightedPoints, shouldStronglyAlert } = require('../src/roadAlertsMatching');
const { isPushConfigured, configureWebPush } = require('../src/pushKeys');

const CHECK_INTERVAL_MS = 60000;

/**
 * One pass over every active driver: fetch their nearby hazards and
 * weighted points, run the same route-approach matching the client does,
 * and push for any new serious/need_to_know match. `deps` lets tests
 * inject fakes for getRoadSignals/getWeightedPoints/webPush without a
 * real network call or real push service.
 */
async function runPushCheckOnce(pool, deps = {}) {
  const getRoadSignals = deps.getRoadSignals || realGetRoadSignals;
  const getWeightedPoints = deps.getWeightedPoints || realGetWeightedPoints;
  const webPush = deps.webPush || require('web-push');

  const activePositions = await getActiveLivePositions(pool);

  for (const position of activePositions) {
    const user = { latitude: position.latitude, longitude: position.longitude };

    let signals;
    try {
      const result = await getRoadSignals({ latitude: user.latitude, longitude: user.longitude, radiusMeters: 10000 });
      signals = result.signals;
    } catch (err) {
      console.error(`Failed to fetch hazards for account ${position.account_id}:`, err.message);
      continue;
    }

    const weightedPoints = await getWeightedPoints(pool, position.email);
    const alerts = findAlertsForWeightedPoints(user, weightedPoints, signals);
    const strongAlerts = alerts.filter((alert) => shouldStronglyAlert(alert.signal.severity));

    for (const alert of strongAlerts) {
      if (await hasAlreadySentPush(pool, position.account_id, alert.signal.id)) continue;

      const subscriptions = await getSubscriptionsForAccount(pool, position.account_id);
      const payload = JSON.stringify({
        title: `${alert.signal.severity === 'serious' ? 'Serious' : 'Need to know'} road alert`,
        body: alert.signal.speech.brief,
      });

      // anySucceeded gates recordPushSent below -- ruled on during Task 5's
      // review (an earlier draft of this step called recordPushSent
      // unconditionally, which permanently and silently dropped a
      // serious/need_to_know alert whenever an account had zero
      // subscriptions yet, or every send failed with a transient
      // non-410 error; neither case should count as "delivered").
      let anySucceeded = false;
      for (const subscription of subscriptions) {
        try {
          await webPush.sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            payload
          );
          anySucceeded = true;
        } catch (err) {
          if (err.statusCode === 410) {
            await deleteSubscriptionByEndpoint(pool, subscription.endpoint);
          } else {
            console.error(`Push send failed for account ${position.account_id}:`, err.message);
          }
        }
      }

      if (anySucceeded) {
        await recordPushSent(pool, position.account_id, alert.signal.id);
      }
    }
  }
}

async function main() {
  const USERS_DSN = process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';
  const pool = new Pool({ connectionString: USERS_DSN });
  await ensureRoadAlertsAccountsTable(pool);
  await ensureWeightedPointsTable(pool);
  await ensureRoadAlertsPushTables(pool);

  if (!isPushConfigured()) {
    console.warn('VAPID keys not configured -- road-alerts-push-worker will run but never send anything.');
  } else {
    configureWebPush(require('web-push'));
  }

  console.log(`road-alerts-push-worker started, checking every ${CHECK_INTERVAL_MS}ms`);
  setInterval(() => {
    runPushCheckOnce(pool).catch((err) => console.error('Push check failed:', err));
  }, CHECK_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { runPushCheckOnce };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd geocoding-server && node --test test/roadAlertsPushWorker.test.js`
Expected: PASS, 3 tests. If the first test's coordinates don't actually land inside the matching corridor (real spherical-trig geometry, not the flat-plane approximation used elsewhere), adjust the hazard's `latitude` in the test slightly (e.g. `43.665`) and re-run until it matches -- the exact value matters less than confirming a real geometric match works end-to-end.

- [ ] **Step 5: Create `ops/geocoding-road-alerts-push-worker.service`**

Mirror `ops/geocoding-server.service`'s shape exactly (long-running `Type=simple`, not a `.timer` pair, since the 60s interval is internal to the script):

```ini
# systemd service for geocoding-server/scripts/road-alerts-push-worker.js
# -- a long-running process (not a one-shot triggered by a .timer, unlike
# geocoding-road-alerts-digest.service) that checks every active driver's
# live position against current hazards every 60 seconds and sends a Web
# Push for any new serious/need_to_know match. See
# docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
#
# Install (adjust WorkingDirectory/paths/DSN for the actual box):
#   sudo cp ops/geocoding-road-alerts-push-worker.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now geocoding-road-alerts-push-worker
#
# Check status / logs:
#   systemctl status geocoding-road-alerts-push-worker
#   journalctl -u geocoding-road-alerts-push-worker -f

[Unit]
Description=Road Alerts background push-matching worker
After=network.target postgresql.service

[Service]
Type=simple
User=my_ai
Group=my_ai
WorkingDirectory=/home/my_ai/geocoding/geocoding-server
ExecStart=/usr/bin/node scripts/road-alerts-push-worker.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Commit**

```bash
git add geocoding-server/scripts/road-alerts-push-worker.js geocoding-server/test/roadAlertsPushWorker.test.js ops/geocoding-road-alerts-push-worker.service
git commit -m "Add background push-matching worker and its systemd unit"
```

---

### Task 6: Service worker (push receive only)

**Files:**
- Create: `ui/desktop/public/sw.js`
- Modify: `ui/desktop/src/main.tsx`

**Interfaces:**
- Consumes: nothing (a static file Vite serves verbatim, same as `manifest.webmanifest`).
- Produces: a registered service worker at scope `/`, ready to receive `push` events once Task 7 completes a subscription.

- [ ] **Step 1: Create `ui/desktop/public/sw.js`**

No test framework runs inside a service worker context in this project (same limitation PR #62 already accepted for the `Notification` API) -- this step is manual-verification-only, confirmed in Step 3 below.

```js
// Push-receive only -- no offline caching/precaching here (see
// docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md's
// scope: "no offline caching PWA behavior" is explicitly out of scope).
// Served verbatim from /sw.js by Vite, same as manifest.webmanifest,
// robots.txt, sitemap.xml -- no build step needed.

self.addEventListener('push', (event) => {
  let data = { title: 'Road Alert', body: '' };
  try {
    data = event.data.json();
  } catch {
    // Best-effort -- a malformed payload still shows a generic notification
    // rather than throwing and dropping the push entirely.
  }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/road-alerts');
    })
  );
});
```

- [ ] **Step 2: Register it from `main.tsx`**

Add after the existing `setApiBaseUrl` block:

```tsx
// Push-receive only (see public/sw.js) -- graceful no-op on a browser
// without service worker support, same "unsupported = silent no-op"
// convention as roadAlertNotifications.ts.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Best-effort -- see above.
  });
}
```

- [ ] **Step 3: Manual verification**

Run: `cd ui/desktop && npm run dev`, open the app in a browser, open DevTools → Application → Service Workers.
Expected: `sw.js` shows as registered and activated at scope `/`.

- [ ] **Step 4: Run the existing desktop test suite to confirm nothing broke**

Run: `cd ui/desktop && npm test`
Expected: PASS, same count as before (the `serviceWorker` guard means this is a no-op in the jsdom test environment, which has no `serviceWorker` on `navigator`).

- [ ] **Step 5: Commit**

```bash
git add ui/desktop/public/sw.js ui/desktop/src/main.tsx
git commit -m "Add a push-only service worker"
```

---

### Task 7: Frontend push subscription and live-position wiring

**Files:**
- Modify: `ui/desktop/src/roadAlertNotifications.ts`
- Modify: `ui/desktop/src/roadAlertNotifications.test.ts` (find the existing test file for this module -- if it doesn't exist yet, create it following the same describe/it structure as `ui/shared/roadAlertsMatching.test.ts`)
- Modify: `ui/shared/api/client.ts`
- Modify: `ui/desktop/src/pages/RoadAlerts.tsx`

**Interfaces:**
- Consumes: `getRoadAlertsPushPublicKey`, `subscribeRoadAlertsPush`, `postRoadAlertsLivePosition`, `deleteRoadAlertsLivePosition` (new, this task, in `ui/shared/api/client.ts`).
- Produces: `isPushCapable()`, `subscribeToPush(publicKey)` from `roadAlertNotifications.ts`, used in `RoadAlerts.tsx`'s `handleStart`.

- [ ] **Step 1: Write the failing test for `isPushCapable`**

Add to (or create) `ui/desktop/src/roadAlertNotifications.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPushCapable } from './roadAlertNotifications';

describe('isPushCapable', () => {
  it('is false when serviceWorker or PushManager is unavailable', () => {
    // jsdom (this project's test environment) has neither -- see vite.config.ts's test.environment.
    expect(isPushCapable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui/desktop && npx vitest run src/roadAlertNotifications.test.ts`
Expected: FAIL — `isPushCapable is not exported`.

- [ ] **Step 3: Add `isPushCapable` and `subscribeToPush` to `roadAlertNotifications.ts`**

Add near `isNotificationAvailable`:

```ts
/**
 * Push requires a service worker plus the PushManager API -- false on
 * iOS Safari unless the page is currently running in installed (Home
 * Screen) mode, which is exactly the gate wanted here: no point asking
 * for a push subscription from a regular browser tab, since it will
 * simply fail. See docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
 */
export function isPushCapable(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

/**
 * Subscribes this browser to Web Push, returning the subscription object
 * ready to POST to /road-signals/push-subscribe -- null if unsupported
 * or the subscribe call itself fails (e.g. permission not granted),
 * never throws, same graceful-degrade convention as the rest of this file.
 */
export async function subscribeToPush(publicKey: string): Promise<PushSubscriptionJSON | null> {
  if (!isPushCapable()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    return subscription.toJSON();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui/desktop && npx vitest run src/roadAlertNotifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the four new API client functions to `ui/shared/api/client.ts`**

Add near `markRoadAlertsNotificationsViewed`:

```ts
export function getRoadAlertsPushPublicKey(baseUrl = DEFAULT_API_BASE_URL): Promise<{ publicKey: string }> {
  return getJson<{ publicKey: string }>(baseUrl, '/road-signals/push-public-key');
}

export function subscribeRoadAlertsPush(
  params: { email: string; serviceKey: string; subscription: unknown },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<{ subscribed: boolean }> {
  return postJson<{ subscribed: boolean }>(baseUrl, '/road-signals/push-subscribe', params);
}

export function postRoadAlertsLivePosition(
  params: { email: string; serviceKey: string; latitude: number; longitude: number; heading: number | null },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<{ updated: boolean }> {
  return postJson<{ updated: boolean }>(baseUrl, '/road-signals/live-position', params);
}

export function deleteRoadAlertsLivePosition(
  params: { email: string; serviceKey: string },
  baseUrl = DEFAULT_API_BASE_URL
): Promise<{ deleted: boolean }> {
  const qs = new URLSearchParams({ email: params.email, serviceKey: params.serviceKey });
  return deleteJson<{ deleted: boolean }>(baseUrl, `/road-signals/live-position?${qs.toString()}`);
}
```

- [ ] **Step 6: Wire into `RoadAlerts.tsx`**

Add to the shared import block (alongside the existing `getRoadSignals` etc. import from Step 5 of Task 1):

```tsx
import {
  // ...existing imports...
  deleteRoadAlertsLivePosition,
  getRoadAlertsPushPublicKey,
  postRoadAlertsLivePosition,
  subscribeRoadAlertsPush,
} from '../../../shared/api/client';
```

And to the `roadAlertNotifications` import at the top of the file:

```tsx
import {
  isPushCapable,
  playAlertChime,
  requestNotificationPermission,
  showAlertNotification,
  subscribeToPush,
} from '../roadAlertNotifications';
```

In `handleStart`, right after the existing `requestNotificationPermission();` call:

```tsx
// Best-effort, fire-and-forget -- a driver on a browser tab (not an
// installed PWA) simply never gets a subscription, and keeps exactly
// today's chime/in-tab-notification behavior. See
// docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
if (isPushCapable()) {
  const current = accountRef.current;
  if (current) {
    getRoadAlertsPushPublicKey()
      .then(({ publicKey }) => subscribeToPush(publicKey))
      .then((subscription) => {
        if (subscription) {
          return subscribeRoadAlertsPush({ email: current.email, serviceKey: current.serviceKey, subscription });
        }
      })
      .catch(() => {
        // Best-effort -- push-public-key 404s (unconfigured server) land here too.
      });
  }
}
```

In `handleStop`, right after the existing `trailRef.current = []; setOnRouteIds(new Set());` lines:

```tsx
// Removes the ephemeral live-position row immediately rather than
// waiting for the worker's 10-minute staleness timeout.
const stoppedAccount = accountRef.current;
if (stoppedAccount) {
  deleteRoadAlertsLivePosition({ email: stoppedAccount.email, serviceKey: stoppedAccount.serviceKey }).catch(() => {
    // Best-effort -- see above.
  });
}
```

In `fetchSignals`, right after the existing `const response = await getRoadSignals({...})` call succeeds (i.e. right before `setSignals(response.signals);`):

```tsx
// Piggybacks on the same throttled cadence fetchSignals already runs
// at (POLL_MIN_INTERVAL_MS) -- no separate timer needed.
postRoadAlertsLivePosition({
  email: current.email,
  serviceKey: current.serviceKey,
  latitude,
  longitude,
  heading,
}).catch(() => {
  // Best-effort -- a failed position update shouldn't block hazard display.
});
```

- [ ] **Step 7: Run the desktop test suite**

Run: `cd ui/desktop && npm test`
Expected: PASS, same pre-existing test count plus the one new `isPushCapable` test.

- [ ] **Step 8: Manual verification (required -- see spec's Testing strategy)**

Install the PWA on an actual iPhone (Safari → Share → Add to Home Screen), open the installed app, grant notification permission on Start, confirm (via the server logs / `journalctl -u geocoding-road-alerts-push-worker`) that a live-position row appears and a subscription is stored. Full end-to-end push delivery needs `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` actually set on whichever server this is tested against (generate via `npx web-push generate-vapid-keys` -- not part of this plan's automated steps, a one-time manual `.env` addition on `geocoding-test` before this can be verified live).

- [ ] **Step 9: Commit**

```bash
git add ui/desktop/src/roadAlertNotifications.ts ui/desktop/src/roadAlertNotifications.test.ts \
  ui/shared/api/client.ts ui/desktop/src/pages/RoadAlerts.tsx
git commit -m "Wire up push subscription and live-position reporting in Road Alerts"
```

---

### Task 8: Privacy documentation update

**Files:**
- Modify: `docs/ROAD_ALERTS_DESIGN.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (documentation only).

- [ ] **Step 1: Add the addendum**

In `docs/ROAD_ALERTS_DESIGN.md`'s Privacy model section, add after the existing "Addendum, 2026-09-12" paragraph (the route-approach trail one):

```markdown
**Addendum, 2026-09-17:** background push alerts (see
`docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md`)
introduce a genuinely new category of data leaving the browser -- unlike
the 2026-09-12 trail above, which never leaves the device, an installed-PWA
user's **current position** (a single point, not a trail) is sent to the
server while a drive is actively in progress. This is real, and worth
being explicit about rather than folding into the existing "no raw trip
trace stored" language above:

- It exists on the server **only while a drive is actively in progress**
  (Start pressed through Stop pressed, or a 10-minute inactivity timeout)
  and is **never appended to any history table** -- one row per account,
  always overwritten in place, deleted (not merely marked inactive) on
  Stop or timeout.
- It is **opt-in twice over**: sent at all only if the driver has both
  installed the app to their Home Screen/desktop *and* granted
  notification permission. A driver who never installs the app sends no
  live position, ever, and keeps exactly the chime/in-tab-notification
  behavior from PR #62 unchanged.
- It exists specifically because iOS has no background-sync API a closed
  tab could use to re-check hazards on its own -- a real Web Push, sent
  from a server that knows roughly where the driver currently is, is the
  only way to reach a closed app on that platform at all.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ROAD_ALERTS_DESIGN.md
git commit -m "Document the background-push live-position privacy addendum"
```
