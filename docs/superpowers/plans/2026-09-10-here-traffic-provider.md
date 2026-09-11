# HERE Traffic API Second Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HERE Technologies' Traffic API v7 as a second Road Alerts hazard-data
provider, giving real Texas (and nationwide) coverage alongside the existing New
England 511 integration, which stays authoritative for Maine/NH/Vermont.

**Architecture:** Extract the provider-agnostic geo/classification helpers
(`boundingBoxDegrees`, `filterByBbox`, `sortByFreshness`, `HAZARD_CATEGORIES`,
`categorizeHazard`) out of `roadSignals.js` into a new `roadSignalsShared.js`, so a new
`hereTraffic.js` (HERE-specific fetch + normalize) and `roadSignals.js` (New England 511,
unchanged behavior, now the geography-gated dispatcher) can both depend on it without a
circular `require()` between the two provider files. A bounding box covering ME/NH/VT
decides which single provider runs for a given request — never both.

**Tech Stack:** Node.js, `node:test`/`node:assert`, `fetch`/`AbortSignal.timeout` (same
pattern `roadSignals.js` already uses for New England 511), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-here-traffic-provider-design.md`

## Global Constraints

- HERE endpoint: `https://data.traffic.hereapi.com/v7/incidents?in=circle:{lat},{lon};r={radiusMeters}&locationReferencing=shape&apiKey={key}` — `shape`, not `olr` (see spec's correction).
- `HERE_API_KEY` env var, optional — unset means the HERE path is silently skipped (no error), same as `billing.js`'s `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` pattern.
- `roadSignals.js`'s public exports (`getRoadSignals`, `asArray`, `parseIncidentsXml`, `extractIncidents`, `normalizeIncident`, `mapSeverity`, `categorizeHazard`, `HAZARD_CATEGORIES`, `buildSpeech`, `formatLaneDetail`, `formatWeightRestriction`, `boundingBoxDegrees`, `filterByBbox`, `sortByFreshness`, `MAX_RADIUS_METERS`) must all keep working exactly as before — `roadSignals.test.js` and `roadSignalsEndpoint.test.js`'s existing tests must pass unmodified.
- No changes to `ui/shared/api/types.ts` or any UI code — the `RoadSignal`/`RoadSignalsResponse` shapes stay identical.
- A failed HERE fetch throws `UpstreamError` (→ HTTP 502), matching New England 511's own all-networks-failed convention — never a soft partial response for a single-provider failure.
- No caching for the HERE path (deferred, documented in the spec) and no incident deduplication (not needed — the two providers never run for the same request).

---

## Task 1: Extract shared geo/classification helpers into `roadSignalsShared.js`

**Files:**
- Create: `geocoding-server/src/roadSignalsShared.js`
- Modify: `geocoding-server/src/roadSignals.js`
- Test: `geocoding-server/test/roadSignals.test.js` (existing — must pass unmodified), `geocoding-server/test/roadSignalsEndpoint.test.js` (existing — must pass unmodified)

**Interfaces:**
- Produces: `roadSignalsShared.js` exports `boundingBoxDegrees(latitude, longitude, radiusMeters)`, `filterByBbox(incidents, latitude, longitude, radiusMeters)`, `sortByFreshness(incidents)`, `HAZARD_CATEGORIES` (array), `categorizeHazard({ raw511EventType, description })`. This is what Task 2/3/4 (`hereTraffic.js`) and Task 6 (`roadSignals.js`'s dispatcher) both import from — never from `roadSignals.js` or `hereTraffic.js` directly.

This is a pure, behavior-preserving move — no new tests to write, since nothing new is being built. The two existing test files that import these functions from `roadSignals.js` must keep passing without modification, proving the move changed nothing observable.

- [ ] **Step 1: Create `roadSignalsShared.js` with the five moved pieces**

```js
/**
 * Provider-agnostic geo/classification helpers shared between
 * roadSignals.js (New England 511) and hereTraffic.js (HERE Traffic
 * API). Extracted out of roadSignals.js so both provider modules can
 * import from here without a circular require between them --
 * roadSignals.js needs to require hereTraffic.js for its geographic
 * dispatcher, and if hereTraffic.js required roadSignals.js back,
 * Node's CommonJS would hand it a still-initializing, incomplete module
 * (whichever file loads second in a require cycle sees the first one's
 * exports before that first file has finished running).
 */

/**
 * Flat rectangle approximation (not a true geodesic circle), same
 * approach as placesSearch.js's metersToViewbox -- more than accurate
 * enough for "what's roughly nearby" filtering.
 */
function boundingBoxDegrees(latitude, longitude, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.cos((latitude * Math.PI) / 180));
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLon: longitude - lonDelta,
    maxLon: longitude + lonDelta,
  };
}

function filterByBbox(incidents, latitude, longitude, radiusMeters) {
  const box = boundingBoxDegrees(latitude, longitude, radiusMeters);
  return incidents.filter(
    (incident) =>
      typeof incident.latitude === 'number' &&
      typeof incident.longitude === 'number' &&
      incident.latitude >= box.minLat &&
      incident.latitude <= box.maxLat &&
      incident.longitude >= box.minLon &&
      incident.longitude <= box.maxLon
  );
}

/**
 * Most-recently-updated first, so a driver re-opening the list sees
 * what's newest at a glance rather than whatever order the upstream
 * provider happened to return it in. Falls back to `createdAt` when
 * `lastUpdatedAt` is missing -- `lastUpdatedAt` is still preferred when
 * both exist, since it reflects how current the information actually
 * is, not just when the incident was first reported. An incident with
 * neither timestamp sorts last (treated as oldest/least certain), not
 * first.
 */
function freshnessTimestamp(incident) {
  const raw = incident.lastUpdatedAt || incident.createdAt;
  if (!raw) return -Infinity;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function sortByFreshness(incidents) {
  return [...incidents].sort((a, b) => freshnessTimestamp(b) - freshnessTimestamp(a));
}

// The full set HAZARD_CATEGORY_ICONS (ui/shared/hazardCategories.ts) has
// an icon for -- kept here, not derived from that file, since this
// module has no business depending on a UI-layer file; the two are kept
// in sync by hand, same as ui/shared/api/types.ts already mirrors this
// server's response shapes by hand elsewhere in the codebase.
const HAZARD_CATEGORIES = [
  'hazmat',
  'accident',
  'construction',
  'closure',
  'congestion',
  'obstruction',
  'weather',
  'other',
];

/**
 * Keyword-matching hazard categorizer over freeform `eventType`/
 * `description` text -- shared by both providers since neither New
 * England 511 nor several of HERE's own incident types give a fully
 * structured hazard category. Checked most-specific/most-dangerous
 * first (a "chemical spill during a road closure" should read as
 * hazmat, not just a closure) down to the generic fallback `other`,
 * which is deliberately NOT the same bucket as a real category guess --
 * better to show a plain warning icon than a wrong specific one.
 */
function categorizeHazard({ raw511EventType, description }) {
  const text = `${raw511EventType || ''} ${description || ''}`.toLowerCase();
  if (/hazmat|hazardous material|chemical|fuel spill|gas leak|toxic/.test(text)) return 'hazmat';
  if (/accident|crash|collision/.test(text)) return 'accident';
  if (/construction|road work|roadwork|repav|paving|maintenance/.test(text)) return 'construction';
  if (/closed|closure/.test(text)) return 'closure';
  if (/congestion|heavy traffic|backup/.test(text)) return 'congestion';
  if (/disabled vehicle|debris|stall|obstruction/.test(text)) return 'obstruction';
  if (/flood|icy|ice|snow|weather|fog/.test(text)) return 'weather';
  return 'other';
}

module.exports = {
  boundingBoxDegrees,
  filterByBbox,
  sortByFreshness,
  HAZARD_CATEGORIES,
  categorizeHazard,
};
```

- [ ] **Step 2: Remove the five moved pieces from `roadSignals.js` and import them from the new file instead**

In `geocoding-server/src/roadSignals.js`:

Replace the top-of-file requires:
```js
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { ValidationError, UpstreamError } = require('./errors');
```
with:
```js
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { ValidationError, UpstreamError } = require('./errors');
const { boundingBoxDegrees, filterByBbox, sortByFreshness, HAZARD_CATEGORIES, categorizeHazard } = require('./roadSignalsShared');
```

Delete this whole block (the `HAZARD_CATEGORIES` const and `categorizeHazard` function, now living in `roadSignalsShared.js`):
```js
// The full set HAZARD_CATEGORY_ICONS (ui/shared/hazardCategories.ts) has
// an icon for -- kept here, not derived from that file, since this module
// has no business depending on a UI-layer file; the two are kept in sync
// by hand, same as ui/shared/api/types.ts already mirrors this server's
// response shapes by hand elsewhere in the codebase.
const HAZARD_CATEGORIES = [
  'hazmat',
  'accident',
  'construction',
  'closure',
  'congestion',
  'obstruction',
  'weather',
  'other',
];

/**
 * Same keyword-matching approach as mapSeverity just above, over the same
 * `eventType`/`description` text -- 511 has no separate structured
 * "hazard type" field at all (confirmed by live sampling across all 3
 * networks, same as every other `raw511*`-prefixed field this module
 * reads), so free-text keywords are the only signal available. Checked
 * most-specific/most-dangerous first (a "chemical spill during a road
 * closure" should read as hazmat, not just a closure) down to the
 * generic fallback `other`, which is deliberately NOT the same bucket as
 * a real category guess -- better to show a plain warning icon than a
 * wrong specific one.
 */
function categorizeHazard({ raw511EventType, description }) {
  const text = `${raw511EventType || ''} ${description || ''}`.toLowerCase();
  if (/hazmat|hazardous material|chemical|fuel spill|gas leak|toxic/.test(text)) return 'hazmat';
  if (/accident|crash|collision/.test(text)) return 'accident';
  if (/construction|road work|roadwork|repav|paving|maintenance/.test(text)) return 'construction';
  if (/closed|closure/.test(text)) return 'closure';
  if (/congestion|heavy traffic|backup/.test(text)) return 'congestion';
  if (/disabled vehicle|debris|stall|obstruction/.test(text)) return 'obstruction';
  if (/flood|icy|ice|snow|weather|fog/.test(text)) return 'weather';
  return 'other';
}
```
(Keep everything before and after this block exactly as-is — `mapSeverity` above it and `buildSpeech` below it are untouched.)

Delete this block (now living in `roadSignalsShared.js`):
```js
/**
 * Flat rectangle approximation (not a true geodesic circle), same
 * approach as placesSearch.js's metersToViewbox -- more than accurate
 * enough for "what's roughly nearby" filtering.
 */
function boundingBoxDegrees(latitude, longitude, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.cos((latitude * Math.PI) / 180));
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLon: longitude - lonDelta,
    maxLon: longitude + lonDelta,
  };
}

/**
 * Most-recently-updated first, so a driver re-opening the list sees what's
 * newest at a glance rather than whatever order 511 happened to return
 * (observed to be roughly network-grouping, not chronological). Falls
 * back to `createdAt` when `lastUpdatedAt` is missing (511 doesn't always
 * carry the latter -- see normalizeIncident's `createdAt` comment) --
 * `lastUpdatedAt` is still preferred when both exist, since it reflects
 * how current the information actually is, not just when the incident
 * was first reported. An incident with neither timestamp sorts last
 * (treated as oldest/least certain), not first.
 */
function freshnessTimestamp(incident) {
  const raw = incident.lastUpdatedAt || incident.createdAt;
  if (!raw) return -Infinity;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function sortByFreshness(incidents) {
  return [...incidents].sort((a, b) => freshnessTimestamp(b) - freshnessTimestamp(a));
}

function filterByBbox(incidents, latitude, longitude, radiusMeters) {
  const box = boundingBoxDegrees(latitude, longitude, radiusMeters);
  return incidents.filter(
    (incident) =>
      typeof incident.latitude === 'number' &&
      typeof incident.longitude === 'number' &&
      incident.latitude >= box.minLat &&
      incident.latitude <= box.maxLat &&
      incident.longitude >= box.minLon &&
      incident.longitude <= box.maxLon
  );
}
```
(This sits between `normalizeIncident` above it and `fetchNetworkIncidents` below it — keep both of those exactly as-is.)

`module.exports` at the bottom of `roadSignals.js` stays **exactly the same** (same keys, same order) — the values it references (`boundingBoxDegrees`, `filterByBbox`, `sortByFreshness`, `HAZARD_CATEGORIES`, `categorizeHazard`) now come from the `require('./roadSignalsShared')` destructure at the top instead of being locally defined, but the export surface is identical.

- [ ] **Step 3: Run the full existing test suite to confirm zero regressions**

Run: `cd geocoding-server && node --test test/roadSignals.test.js test/roadSignalsEndpoint.test.js`
Expected: all tests pass, identical to before this change (this is the "test" for a pure refactor — nothing new to assert, just proof nothing broke).

- [ ] **Step 4: Commit**

```bash
git add geocoding-server/src/roadSignalsShared.js geocoding-server/src/roadSignals.js
git commit -m "Extract shared geo/classification helpers into roadSignalsShared.js

Moves boundingBoxDegrees/filterByBbox/sortByFreshness/HAZARD_CATEGORIES/
categorizeHazard out of roadSignals.js so a new hereTraffic.js can reuse
them without a circular require (roadSignals.js will need to require
hereTraffic.js for its geographic dispatcher in a later commit). Pure
move, zero behavior change -- roadSignals.js's own exports and existing
tests are unaffected."
```

---

## Task 2: `hereTraffic.js` — `isHereConfigured` and `mapHereSeverity`

**Files:**
- Create: `geocoding-server/src/hereTraffic.js`
- Test: `geocoding-server/test/hereTraffic.test.js` (new)

**Interfaces:**
- Consumes: nothing yet (pure functions + one env var read).
- Produces: `isHereConfigured(): boolean`, `mapHereSeverity({ criticality, roadClosed, type }): 'serious' | 'need_to_know' | 'proximity'` — Task 4 (`normalizeHereIncident`) calls this.

- [ ] **Step 1: Write the failing tests**

Create `geocoding-server/test/hereTraffic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { isHereConfigured, mapHereSeverity } = require('../src/hereTraffic');

test('isHereConfigured is false when HERE_API_KEY is unset', () => {
  const saved = process.env.HERE_API_KEY;
  delete process.env.HERE_API_KEY;
  try {
    assert.equal(isHereConfigured(), false);
  } finally {
    if (saved !== undefined) process.env.HERE_API_KEY = saved;
  }
});

test('isHereConfigured is true when HERE_API_KEY is set', () => {
  const saved = process.env.HERE_API_KEY;
  process.env.HERE_API_KEY = 'test-key';
  try {
    assert.equal(isHereConfigured(), true);
  } finally {
    if (saved !== undefined) process.env.HERE_API_KEY = saved;
    else delete process.env.HERE_API_KEY;
  }
});

// roadClosed/type/criticality values below are exactly as observed live
// from HERE Traffic API v7 against real Dallas, TX incidents this
// session -- see docs/superpowers/specs/2026-09-10-here-traffic-provider-design.md.
test('mapHereSeverity maps a real road closure (roadClosed: true) to serious', () => {
  assert.equal(mapHereSeverity({ criticality: 'critical', roadClosed: true, type: 'roadClosure' }), 'serious');
});

test('mapHereSeverity maps type roadClosure to serious even if roadClosed were false', () => {
  assert.equal(mapHereSeverity({ criticality: 'minor', roadClosed: false, type: 'roadClosure' }), 'serious');
});

test('mapHereSeverity maps criticality critical to serious regardless of type', () => {
  assert.equal(mapHereSeverity({ criticality: 'critical', roadClosed: false, type: 'plannedEvent' }), 'serious');
});

test('mapHereSeverity maps criticality major to need_to_know', () => {
  assert.equal(mapHereSeverity({ criticality: 'major', roadClosed: false, type: 'construction' }), 'need_to_know');
});

test('mapHereSeverity maps criticality minor to proximity', () => {
  assert.equal(mapHereSeverity({ criticality: 'minor', roadClosed: false, type: 'construction' }), 'proximity');
});

test('mapHereSeverity falls back to proximity for an unrecognized criticality value', () => {
  assert.equal(mapHereSeverity({ criticality: 'unknown-future-value', roadClosed: false, type: 'other' }), 'proximity');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: FAIL — `Cannot find module '../src/hereTraffic'` (the file doesn't exist yet).

- [ ] **Step 3: Create `hereTraffic.js` with the minimal implementation**

```js
// Real, working, paid alternative to New England 511 for everywhere
// NE511 doesn't cover (see docs/ROAD_ALERTS_DESIGN.md's "Texas coverage"
// section for the research trail, and
// docs/superpowers/specs/2026-09-10-here-traffic-provider-design.md for
// the full design). 30,000 free transactions/month, no credit card --
// confirmed live against real Dallas/Portland locations before this was
// built.

/** Whether HERE_API_KEY is set -- mirrors billing.js's isConfigured() pattern for an optional paid integration. */
function isHereConfigured() {
  return Boolean(process.env.HERE_API_KEY);
}

/**
 * Unlike New England 511 (no structured severity field, forcing
 * roadSignals.js's mapSeverity to guess from keywords), HERE gives
 * structured fields directly -- mapped here rather than degraded back
 * through a keyword matcher, which would throw away real signal.
 * roadClosed/type==='roadClosure'/criticality==='critical' all bump to
 * `serious`, mirroring New England 511's own "closure bumps to serious
 * regardless" rule.
 */
function mapHereSeverity({ criticality, roadClosed, type }) {
  if (roadClosed || type === 'roadClosure' || criticality === 'critical') return 'serious';
  if (criticality === 'major') return 'need_to_know';
  return 'proximity';
}

module.exports = {
  isHereConfigured,
  mapHereSeverity,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add geocoding-server/src/hereTraffic.js geocoding-server/test/hereTraffic.test.js
git commit -m "Add isHereConfigured and mapHereSeverity to hereTraffic.js"
```

---

## Task 3: `hereTraffic.js` — `categorizeHereIncident` and `extractRoadwayFromDescription`

**Files:**
- Modify: `geocoding-server/src/hereTraffic.js`
- Test: `geocoding-server/test/hereTraffic.test.js`

**Interfaces:**
- Consumes: `categorizeHazard` from `roadSignalsShared.js` (Task 1).
- Produces: `categorizeHereIncident({ type, typeDescription, description }): HazardCategory`, `extractRoadwayFromDescription(description: string | null): string | null` — both used by Task 4's `normalizeHereIncident`.

- [ ] **Step 1: Write the failing tests**

Append to `geocoding-server/test/hereTraffic.test.js` (add to the existing `require` line too — see below):

```js
// (update the top require line to:)
// const { isHereConfigured, mapHereSeverity, categorizeHereIncident, extractRoadwayFromDescription } = require('../src/hereTraffic');

// description/type values below are real, sampled live from HERE
// Traffic API v7 against Dallas, TX incidents this session.
test('categorizeHereIncident maps type construction directly to construction', () => {
  assert.equal(
    categorizeHereIncident({ type: 'construction', typeDescription: { value: 'Road construction' }, description: { value: 'At W Mockingbird Ln - Construction work' } }),
    'construction'
  );
});

test('categorizeHereIncident maps type roadClosure directly to closure', () => {
  assert.equal(
    categorizeHereIncident({ type: 'roadClosure', typeDescription: { value: 'Road closure' }, description: { value: 'Closed' } }),
    'closure'
  );
});

test('categorizeHereIncident maps type congestion directly to congestion', () => {
  assert.equal(
    categorizeHereIncident({ type: 'congestion', typeDescription: { value: 'Congestion' }, description: { value: 'Backed-up traffic' } }),
    'congestion'
  );
});

test('categorizeHereIncident maps type laneRestriction directly to obstruction', () => {
  assert.equal(
    categorizeHereIncident({ type: 'laneRestriction', typeDescription: { value: 'Lane restriction' }, description: { value: 'Turning lane closed' } }),
    'obstruction'
  );
});

test('categorizeHereIncident falls back to the shared keyword matcher for type plannedEvent, defaulting to other', () => {
  assert.equal(
    categorizeHereIncident({ type: 'plannedEvent', typeDescription: { value: 'Planned event' }, description: { value: 'At Caroline St - Fair' } }),
    'other'
  );
});

test('categorizeHereIncident falls back to the shared keyword matcher and can still detect hazmat from description text', () => {
  assert.equal(
    categorizeHereIncident({ type: 'other', typeDescription: { value: 'Other news' }, description: { value: 'Chemical spill on shoulder' } }),
    'hazmat'
  );
});

test('extractRoadwayFromDescription extracts the roadway from an "At X - Y" description', () => {
  assert.equal(extractRoadwayFromDescription('At W Mockingbird Ln - Construction work'), 'W Mockingbird Ln');
  assert.equal(extractRoadwayFromDescription('At TX-289/Preston Rd/Exit 21 - Backed-up traffic. Approach with care'), 'TX-289/Preston Rd/Exit 21');
});

test('extractRoadwayFromDescription returns null when the description does not follow that pattern', () => {
  assert.equal(extractRoadwayFromDescription('Closed'), null);
  assert.equal(extractRoadwayFromDescription('Turning lane closed'), null);
  assert.equal(extractRoadwayFromDescription(null), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: FAIL — `categorizeHereIncident is not a function` / `extractRoadwayFromDescription is not a function`.

- [ ] **Step 3: Add the implementation to `hereTraffic.js`**

Add near the top, after the existing requires (there are none yet — add this line):
```js
const { categorizeHazard } = require('./roadSignalsShared');
```

Add after `mapHereSeverity`:
```js
// Direct type->category mapping for the HERE `type` values confirmed by
// live sampling to line up cleanly with this app's hazard categories.
// HERE's real `type` enum is likely broader than these four -- anything
// else falls through to the shared categorizeHazard() keyword matcher,
// which is what catches hazmat/accident/weather even though they
// weren't in HERE's `type` enum as sampled.
const HERE_TYPE_TO_CATEGORY = {
  construction: 'construction',
  roadClosure: 'closure',
  congestion: 'congestion',
  laneRestriction: 'obstruction',
};

function categorizeHereIncident({ type, typeDescription, description }) {
  const direct = HERE_TYPE_TO_CATEGORY[type];
  if (direct) return direct;
  return categorizeHazard({
    raw511EventType: typeDescription?.value,
    description: description?.value,
  });
}

/**
 * HERE has no separate structured roadway field like New England 511
 * does -- description text commonly follows an "At {roadway} - {detail}"
 * pattern (confirmed by live sampling: construction/congestion/
 * plannedEvent/other incidents all matched this shape; roadClosure/
 * laneRestriction incidents in the same sample did not and fall back to
 * null, same as the UI's existing `signal.roadway ?? 'Unknown road'`
 * already handles for a New England 511 incident with no roadway).
 */
function extractRoadwayFromDescription(description) {
  const match = /^At (.+?) - /.exec(description || '');
  return match ? match[1] : null;
}
```

Update `module.exports`:
```js
module.exports = {
  isHereConfigured,
  mapHereSeverity,
  categorizeHereIncident,
  extractRoadwayFromDescription,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: PASS, all 15 tests (7 from Task 2 + 8 new).

- [ ] **Step 5: Commit**

```bash
git add geocoding-server/src/hereTraffic.js geocoding-server/test/hereTraffic.test.js
git commit -m "Add categorizeHereIncident and extractRoadwayFromDescription"
```

---

## Task 4: `hereTraffic.js` — `normalizeHereIncident`

**Files:**
- Modify: `geocoding-server/src/hereTraffic.js`
- Test: `geocoding-server/test/hereTraffic.test.js`

**Interfaces:**
- Consumes: `mapHereSeverity`, `categorizeHereIncident`, `extractRoadwayFromDescription` (Task 2/3, same file).
- Produces: `normalizeHereIncident(raw): RoadSignal` — one raw `results[]` entry (`{ location, incidentDetails }`) in, one `RoadSignal`-shaped object out. Task 5's `fetchHereIncidents` calls this per result.

- [ ] **Step 1: Write the failing tests**

Append to `geocoding-server/test/hereTraffic.test.js` (update the require line to add `normalizeHereIncident`):

```js
// Real incidents captured live from HERE Traffic API v7 this session
// (Dallas, TX -- circle:32.8626698,-96.7601162;r=10000,
// locationReferencing=shape) -- shape.links trimmed to 2 points for
// readability, incidentDetails kept verbatim.
const REAL_CONSTRUCTION_INCIDENT = {
  location: {
    length: 559.0,
    shape: { links: [{ points: [{ lat: 32.81818, lng: -96.84479 }, { lat: 32.81947, lng: -96.84636 }], length: 206.0, functionalClass: 3 }] },
  },
  incidentDetails: {
    id: '2021742316625632607',
    hrn: 'here:traffic:incident:2021742316625632607',
    startTime: '2026-09-02T16:17:34Z',
    endTime: '2026-09-13T16:17:34Z',
    entryTime: '2026-09-03T15:32:50Z',
    roadClosed: false,
    criticality: 'minor',
    type: 'construction',
    typeDescription: { value: 'Road construction', language: 'en-US' },
    codes: [803, 500],
    description: { value: 'At W Mockingbird Ln - Construction work', language: 'en-US' },
    summary: { value: 'Construction work', language: 'en-US' },
  },
};

const REAL_ROAD_CLOSURE_INCIDENT = {
  location: {
    length: 119.0,
    shape: { links: [{ points: [{ lat: 32.90477, lng: -96.68286 }, { lat: 32.90477, lng: -96.68261 }], length: 23.0, functionalClass: 5 }] },
  },
  incidentDetails: {
    id: '3690011721065073050',
    hrn: 'here:traffic:incident:3690011721065073050',
    startTime: '2026-09-09T22:21:50Z',
    endTime: '2026-09-11T10:21:50Z',
    entryTime: '2026-09-09T22:21:50Z',
    roadClosed: true,
    criticality: 'critical',
    type: 'roadClosure',
    typeDescription: { value: 'Road closure', language: 'en-US' },
    codes: [401],
    description: { value: 'Closed', language: 'en-US' },
    summary: { value: 'Closed', language: 'en-US' },
  },
};

// An incident with no shape data at all -- defensive case, not sampled
// live (every real incident this session had shape data), but HERE's
// docs don't guarantee every location referencing type is always
// present for every incident.
const NO_SHAPE_INCIDENT = {
  location: { length: 10.0 },
  incidentDetails: {
    id: 'no-shape-test-id',
    entryTime: '2026-09-10T00:00:00Z',
    roadClosed: false,
    criticality: 'minor',
    type: 'other',
    typeDescription: { value: 'Other news', language: 'en-US' },
    description: { value: 'Something happened', language: 'en-US' },
    summary: { value: 'Something happened', language: 'en-US' },
  },
};

test('normalizeHereIncident maps a real construction incident to the RoadSignal shape', () => {
  const normalized = normalizeHereIncident(REAL_CONSTRUCTION_INCIDENT);
  assert.equal(normalized.id, '2021742316625632607');
  assert.equal(normalized.type, 'traffic_hazard');
  assert.equal(normalized.source, 'HERE Traffic API');
  assert.equal(normalized.network, 'HERE');
  assert.equal(normalized.roadway, 'W Mockingbird Ln');
  assert.equal(normalized.latitude, 32.81818);
  assert.equal(normalized.longitude, -96.84479);
  assert.equal(normalized.description, 'At W Mockingbird Ln - Construction work');
  assert.equal(normalized.createdAt, '2026-09-03T15:32:50Z');
  assert.equal(normalized.lastUpdatedAt, '2026-09-03T15:32:50Z');
  assert.equal(normalized.severity, 'proximity');
  assert.equal(normalized.hazardCategory, 'construction');
  assert.equal(normalized.speech.brief, 'Construction work');
});

test('normalizeHereIncident maps a real road closure incident to severity serious', () => {
  const normalized = normalizeHereIncident(REAL_ROAD_CLOSURE_INCIDENT);
  assert.equal(normalized.roadway, null);
  assert.equal(normalized.severity, 'serious');
  assert.equal(normalized.hazardCategory, 'closure');
  assert.equal(normalized.latitude, 32.90477);
  assert.equal(normalized.longitude, -96.68286);
});

test('normalizeHereIncident returns null latitude/longitude when there is no shape data', () => {
  const normalized = normalizeHereIncident(NO_SHAPE_INCIDENT);
  assert.equal(normalized.latitude, null);
  assert.equal(normalized.longitude, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: FAIL — `normalizeHereIncident is not a function`.

- [ ] **Step 3: Add the implementation to `hereTraffic.js`**

Add after `extractRoadwayFromDescription`:
```js
/**
 * A HERE incident's `location` describes a road segment (one or more
 * `links`, each a polyline of `points`), not a single point -- this
 * app's RoadSignal needs one representative latitude/longitude (for map
 * markers and bbox filtering), so this takes the first point of the
 * first link. A location with no shape data at all returns nulls, same
 * as roadSignals.js's normalizeIncident does for a New England 511
 * incident with no usable coordinates.
 */
function firstShapePoint(location) {
  const firstPoint = location?.shape?.links?.[0]?.points?.[0];
  if (!firstPoint) return { latitude: null, longitude: null };
  return { latitude: firstPoint.lat, longitude: firstPoint.lng };
}

/**
 * Normalizes one raw HERE `results[]` entry into this app's RoadSignal
 * shape -- same fields roadSignals.js's normalizeIncident produces for
 * New England 511, so downstream code (the GET /road-signals route,
 * roadAlertsMatching) never needs to know which provider produced a
 * given signal.
 *
 * createdAt and lastUpdatedAt both use `entryTime` (when HERE's system
 * recorded this incident) -- HERE's `startTime` is about the real-world
 * incident's own timing (e.g. a construction window that opened days
 * ago), not about how recently the record itself was touched, so using
 * it for `lastUpdatedAt` would make an old-but-still-current incident
 * sort as stale. `raw511Severity`/`raw511EventType` are named for New
 * England 511's own raw fields but are part of the public RoadSignal API
 * type regardless of provider (see ui/shared/api/types.ts) --
 * raw511EventType is populated with HERE's own typeDescription text
 * (the closest equivalent), raw511Severity stays null since HERE's
 * criticality tiers aren't a comparable raw string.
 */
function normalizeHereIncident(raw) {
  const details = raw.incidentDetails;
  const { latitude, longitude } = firstShapePoint(raw.location);
  const roadway = extractRoadwayFromDescription(details.description?.value);

  const normalized = {
    id: details.id,
    type: 'traffic_hazard',
    source: 'HERE Traffic API',
    network: 'HERE',
    status: null,
    roadway,
    direction: null,
    crossStreet: null,
    mileMarker: null,
    county: null,
    city: null,
    latitude,
    longitude,
    affectedLanes: null,
    affectedLanesDetail: null,
    weightRestriction: null,
    description: details.description?.value || null,
    verifiedBy: null,
    createdAt: details.entryTime || null,
    lastUpdatedAt: details.entryTime || null,
    raw511Severity: null,
    raw511EventType: details.typeDescription?.value || null,
  };

  normalized.severity = mapHereSeverity(details);
  normalized.hazardCategory = categorizeHereIncident(details);
  normalized.speech = {
    brief: details.summary?.value || details.typeDescription?.value || 'Traffic incident nearby.',
    average: details.description?.value || details.summary?.value || 'Traffic incident nearby.',
    deep: details.description?.value || details.summary?.value || 'Traffic incident nearby.',
  };

  return normalized;
}
```

Update `module.exports`:
```js
module.exports = {
  isHereConfigured,
  mapHereSeverity,
  categorizeHereIncident,
  extractRoadwayFromDescription,
  normalizeHereIncident,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: PASS, all 18 tests.

- [ ] **Step 5: Commit**

```bash
git add geocoding-server/src/hereTraffic.js geocoding-server/test/hereTraffic.test.js
git commit -m "Add normalizeHereIncident, mapping HERE's shape to RoadSignal"
```

---

## Task 5: `hereTraffic.js` — `fetchHereIncidents` and `getHereIncidents`

**Files:**
- Modify: `geocoding-server/src/hereTraffic.js`
- Test: `geocoding-server/test/hereTraffic.test.js`

**Interfaces:**
- Consumes: `normalizeHereIncident` (Task 4, same file), `filterByBbox`/`sortByFreshness` (`roadSignalsShared.js`, Task 1), `UpstreamError` (`./errors`).
- Produces: `getHereIncidents({ latitude, longitude, radiusMeters }): Promise<RoadSignal[]>` — this is what Task 6's `roadSignals.js` dispatcher calls.

- [ ] **Step 1: Write the failing tests**

Append to `geocoding-server/test/hereTraffic.test.js` (update the require line to add `getHereIncidents`):

```js
// fetchHereIncidents/getHereIncidents call the real global fetch, so
// these tests replace it with a fake for the duration of each test and
// restore it afterward -- same technique roadSignalsEndpoint.test.js
// already uses for New England 511's fetch calls.
function withFakeFetch(respond, fn) {
  return async () => {
    const saved = global.fetch;
    global.fetch = respond;
    try {
      await fn();
    } finally {
      global.fetch = saved;
    }
  };
}

test(
  'getHereIncidents fetches, normalizes, and bbox-filters real HERE results',
  withFakeFetch(
    async (url) => {
      assert.ok(String(url).startsWith('https://data.traffic.hereapi.com/v7/incidents?'));
      assert.ok(String(url).includes('in=circle:32.8626698,-96.7601162;r=10000'));
      assert.ok(String(url).includes('locationReferencing=shape'));
      return {
        ok: true,
        json: async () => ({ results: [REAL_CONSTRUCTION_INCIDENT, REAL_ROAD_CLOSURE_INCIDENT] }),
      };
    },
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        const signals = await getHereIncidents({ latitude: 32.8626698, longitude: -96.7601162, radiusMeters: 10000 });
        assert.equal(signals.length, 2);
        assert.ok(signals.some((s) => s.id === '2021742316625632607'));
        assert.ok(signals.some((s) => s.id === '3690011721065073050'));
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);

test(
  'getHereIncidents throws UpstreamError when the HERE fetch itself fails',
  withFakeFetch(
    async () => {
      throw new Error('network down');
    },
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        await assert.rejects(
          () => getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 }),
          UpstreamError
        );
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);

test(
  'getHereIncidents throws UpstreamError when HERE responds with a non-2xx status',
  withFakeFetch(
    async () => ({ ok: false, status: 500 }),
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        await assert.rejects(
          () => getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 }),
          UpstreamError
        );
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);
```

Also add near the top of the test file (with the other requires):
```js
const { UpstreamError } = require('../src/errors');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: FAIL — `getHereIncidents is not a function`.

- [ ] **Step 3: Add the implementation to `hereTraffic.js`**

Add to the top requires:
```js
const { UpstreamError } = require('./errors');
const { categorizeHazard, filterByBbox, sortByFreshness } = require('./roadSignalsShared');
```
(this replaces the `const { categorizeHazard } = require('./roadSignalsShared');` line added in Task 3 — same line, now importing three names instead of one.)

Add near the top, after the requires:
```js
const HERE_BASE_URL = process.env.HERE_BASE_URL || 'https://data.traffic.hereapi.com/v7/incidents';
const HERE_TIMEOUT_MS = 10000;
```

Add after `normalizeHereIncident`:
```js
/**
 * Fetches live incidents from HERE within `radiusMeters` of (latitude,
 * longitude), already normalized to this app's RoadSignal shape. Throws
 * UpstreamError on any failure (network error, non-2xx response) --
 * HERE is a single provider with no sub-networks to partially succeed
 * across, so a failed fetch here is always the "nothing usable to
 * return" case, same as New England 511's own all-networks-failed throw
 * in roadSignals.js's getRoadSignals.
 */
async function fetchHereIncidents(latitude, longitude, radiusMeters) {
  const url = `${HERE_BASE_URL}?in=circle:${latitude},${longitude};r=${radiusMeters}&locationReferencing=shape&apiKey=${process.env.HERE_API_KEY}`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(HERE_TIMEOUT_MS) });
  } catch (err) {
    throw new UpstreamError(`HERE Traffic API is temporarily unavailable: ${err.message}`);
  }
  if (!response.ok) {
    throw new UpstreamError(`HERE Traffic API is temporarily unavailable (status ${response.status})`);
  }
  const body = await response.json();
  return (body.results || []).map(normalizeHereIncident);
}

/**
 * Top-level entry point roadSignals.js's dispatcher calls -- fetch,
 * normalize, bbox-filter, sort, same shape getRoadSignals already
 * returns for New England 511's `signals` field.
 */
async function getHereIncidents({ latitude, longitude, radiusMeters }) {
  const incidents = await fetchHereIncidents(latitude, longitude, radiusMeters);
  return sortByFreshness(filterByBbox(incidents, latitude, longitude, radiusMeters));
}
```

Update `module.exports`:
```js
module.exports = {
  isHereConfigured,
  mapHereSeverity,
  categorizeHereIncident,
  extractRoadwayFromDescription,
  normalizeHereIncident,
  fetchHereIncidents,
  getHereIncidents,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd geocoding-server && node --test test/hereTraffic.test.js`
Expected: PASS, all 21 tests.

- [ ] **Step 5: Commit**

```bash
git add geocoding-server/src/hereTraffic.js geocoding-server/test/hereTraffic.test.js
git commit -m "Add fetchHereIncidents and getHereIncidents to hereTraffic.js"
```

---

## Task 6: Wire the geographic dispatcher into `roadSignals.js`, plus route-level tests

**Files:**
- Modify: `geocoding-server/src/roadSignals.js`
- Modify: `geocoding-server/test/helpers.js`
- Modify: `geocoding-server/test/roadSignalsEndpoint.test.js`

**Interfaces:**
- Consumes: `isHereConfigured`, `getHereIncidents` (`hereTraffic.js`, Task 5).
- Produces: `getRoadSignals`'s existing public contract, now geography-gated between two providers — this is the final integration point, nothing downstream depends on new exports from this task.

- [ ] **Step 1: Write the failing route-level tests**

In `geocoding-server/test/roadSignalsEndpoint.test.js`, extend the `withFetch` helper to also dispatch HERE requests by hostname (currently it only recognizes New England 511 URLs via a `networks=` regex match):

Replace:
```js
function withFetch(networkResponses, fn) {
  return async (ctx) => {
    delete require.cache[require.resolve('../src/roadSignals')];
    const saved = global.fetch;
    global.fetch = (url, ...args) => {
      if (typeof url === 'string' && url.includes('127.0.0.1')) {
        return saved(url, ...args);
      }
      const match = /networks=([A-Za-z]+)/.exec(url);
      const network = match ? match[1] : null;
      const respond = networkResponses[network];
      if (!respond) {
        return Promise.resolve({ ok: false, status: 500, text: async () => '' });
      }
      return respond();
    };
    try {
      await fn(ctx);
    } finally {
      global.fetch = saved;
    }
  };
}
```
with:
```js
function withFetch(networkResponses, fn, { hereResponse } = {}) {
  return async (ctx) => {
    delete require.cache[require.resolve('../src/roadSignals')];
    delete require.cache[require.resolve('../src/hereTraffic')];
    const saved = global.fetch;
    global.fetch = (url, ...args) => {
      if (typeof url === 'string' && url.includes('127.0.0.1')) {
        return saved(url, ...args);
      }
      if (typeof url === 'string' && url.includes('data.traffic.hereapi.com')) {
        if (!hereResponse) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return hereResponse();
      }
      const match = /networks=([A-Za-z]+)/.exec(url);
      const network = match ? match[1] : null;
      const respond = networkResponses[network];
      if (!respond) {
        return Promise.resolve({ ok: false, status: 500, text: async () => '' });
      }
      return respond();
    };
    try {
      await fn(ctx);
    } finally {
      global.fetch = saved;
    }
  };
}

function hereJsonOk(results) {
  return async () => ({ ok: true, json: async () => ({ results }) });
}
```

Add a `jsonOk`-style helper is not needed since `hereJsonOk` above covers it. Now add the new test cases at the end of the file (after the existing tests, before the final closing of the file):

```js
// A real Dallas, TX incident (construction, minor severity), same shape
// captured live this session -- see hereTraffic.test.js for the full
// object this is trimmed from.
const HERE_DALLAS_INCIDENT = {
  location: { shape: { links: [{ points: [{ lat: 32.81818, lng: -96.84479 }] }] } },
  incidentDetails: {
    id: '2021742316625632607',
    entryTime: '2026-09-03T15:32:50Z',
    roadClosed: false,
    criticality: 'minor',
    type: 'construction',
    typeDescription: { value: 'Road construction' },
    description: { value: 'At W Mockingbird Ln - Construction work' },
    summary: { value: 'Construction work' },
  },
};

test(
  'GET /road-signals routes a Texas location to HERE when HERE_API_KEY is set',
  withFetch(
    {},
    () =>
      withTestServer(
        async ({ port, usersDb }) => {
          const savedKey = process.env.HERE_API_KEY;
          process.env.HERE_API_KEY = 'test-key';
          try {
            const serviceKey = await registerTestAccount(usersDb);
            const response = await fetch(
              roadSignalsUrl(port, { serviceKey, latitude: 32.8626698, longitude: -96.7601162, radiusMeters: 10000 })
            );
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.signals.length, 1);
            assert.equal(body.signals[0].roadway, 'W Mockingbird Ln');
            assert.equal(body.signals[0].network, 'HERE');
            assert.deepEqual(body.networks, ['HERE']);
            assert.equal(body.partial, false);
          } finally {
            if (savedKey !== undefined) process.env.HERE_API_KEY = savedKey;
            else delete process.env.HERE_API_KEY;
          }
        },
        { seedStreets: false }
      ),
    { hereResponse: hereJsonOk([HERE_DALLAS_INCIDENT]) }
  )
);

test(
  'GET /road-signals returns an empty, non-error result for a Texas location when HERE_API_KEY is unset',
  withFetch({}, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const savedKey = process.env.HERE_API_KEY;
        delete process.env.HERE_API_KEY;
        try {
          const serviceKey = await registerTestAccount(usersDb);
          const response = await fetch(
            roadSignalsUrl(port, { serviceKey, latitude: 32.8626698, longitude: -96.7601162, radiusMeters: 10000 })
          );
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.deepEqual(body.signals, []);
          assert.equal(body.partial, false);
        } finally {
          if (savedKey !== undefined) process.env.HERE_API_KEY = savedKey;
        }
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals returns 502 for a Texas location when the HERE fetch fails',
  withFetch(
    {},
    () =>
      withTestServer(
        async ({ port, usersDb }) => {
          const savedKey = process.env.HERE_API_KEY;
          process.env.HERE_API_KEY = 'test-key';
          try {
            const serviceKey = await registerTestAccount(usersDb);
            const response = await fetch(
              roadSignalsUrl(port, { serviceKey, latitude: 32.8626698, longitude: -96.7601162, radiusMeters: 10000 })
            );
            assert.equal(response.status, 502);
          } finally {
            if (savedKey !== undefined) process.env.HERE_API_KEY = savedKey;
            else delete process.env.HERE_API_KEY;
          }
        },
        { seedStreets: false }
      ),
    { hereResponse: async () => ({ ok: false, status: 500 }) }
  )
);

test(
  'GET /road-signals still routes a Maine location to New England 511, even when HERE_API_KEY is set',
  withFetch(
    {
      Maine: xmlOk(statusXml([NEAR_INCIDENT])),
      NewHampshire: xmlOk(statusXml([])),
      Vermont: xmlOk(statusXml([])),
    },
    () =>
      withTestServer(
        async ({ port, usersDb }) => {
          const savedKey = process.env.HERE_API_KEY;
          process.env.HERE_API_KEY = 'test-key';
          try {
            const serviceKey = await registerTestAccount(usersDb);
            const response = await fetch(
              roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 5000 })
            );
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.signals.length, 1);
            assert.deepEqual(body.networks, ['Maine', 'NewHampshire', 'Vermont']);
          } finally {
            if (savedKey !== undefined) process.env.HERE_API_KEY = savedKey;
            else delete process.env.HERE_API_KEY;
          }
        },
        { seedStreets: false }
      )
  )
);
```

**Also**, in `geocoding-server/test/helpers.js`, add `HERE_API_KEY` to the save/delete/restore block so a real local `.env` value (if one is ever added) can't leak into unrelated tests that don't explicitly set it — same rationale as the existing `PAYPAL_CLIENT_ID`/`RESEND_API_KEY` handling. Add right after the `ADMIN_PASSCODE` block:

```js
  // Same rationale again -- a real .env's HERE_API_KEY should never make
  // the "HERE_API_KEY unset" tests pass for the wrong reason, or make an
  // unrelated test's Texas-location request silently start hitting the
  // real HERE API instead of the fake fetch above.
  const savedHereApiKey = process.env.HERE_API_KEY;
  delete process.env.HERE_API_KEY;
```
and in the `finally` block, right after the `ADMIN_PASSCODE` restore line:
```js
    if (savedHereApiKey !== undefined) process.env.HERE_API_KEY = savedHereApiKey;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd geocoding-server && node --test test/roadSignalsEndpoint.test.js`
Expected: the 4 new tests FAIL (a Texas location currently returns `signals: []`/200 regardless of `HERE_API_KEY`, since `roadSignals.js` doesn't dispatch to HERE yet — no 502, no `network: 'HERE'` signals). The existing Maine-based tests still PASS unmodified.

- [ ] **Step 3: Wire the dispatcher into `roadSignals.js`**

Add the import near the top, with the other requires:
```js
const { isHereConfigured, getHereIncidents } = require('./hereTraffic');
```

Add near `MAX_RADIUS_METERS`:
```js
// A simple, generously-padded bounding box covering Maine/NH/Vermont --
// same "flat rectangle approximation" idiom boundingBoxDegrees uses.
// Inside it, New England 511 is used even if HERE is also configured
// (511 is free and one step closer to the source); outside it, HERE is
// used if configured. See docs/superpowers/specs/
// 2026-09-10-here-traffic-provider-design.md for why an explicit gate is
// used instead of "try 511 first, fall back if empty" -- an empty 511
// result for a real in-footprint location with no current incidents is
// indistinguishable from an empty result because the location is simply
// outside 511's coverage.
const NE511_FOOTPRINT_BBOX = { minLat: 42.6, maxLat: 47.5, minLon: -73.5, maxLon: -66.8 };

function isInNe511Footprint(latitude, longitude) {
  return (
    latitude >= NE511_FOOTPRINT_BBOX.minLat &&
    latitude <= NE511_FOOTPRINT_BBOX.maxLat &&
    longitude >= NE511_FOOTPRINT_BBOX.minLon &&
    longitude <= NE511_FOOTPRINT_BBOX.maxLon
  );
}
```

Modify `getRoadSignals` -- replace:
```js
async function getRoadSignals({ latitude, longitude, radiusMeters }) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError('latitude must be a number');
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError('longitude must be a number');
  }
  if (typeof radiusMeters !== 'number' || radiusMeters <= 0) {
    throw new ValidationError('radiusMeters must be a positive number');
  }
  if (radiusMeters > MAX_RADIUS_METERS) {
    throw new ValidationError(`radiusMeters must be at most ${MAX_RADIUS_METERS}`);
  }

  const settled = await Promise.allSettled(NE511_NETWORKS.map(fetchNetworkIncidentsCached));
```
with:
```js
async function getRoadSignals({ latitude, longitude, radiusMeters }) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError('latitude must be a number');
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError('longitude must be a number');
  }
  if (typeof radiusMeters !== 'number' || radiusMeters <= 0) {
    throw new ValidationError('radiusMeters must be a positive number');
  }
  if (radiusMeters > MAX_RADIUS_METERS) {
    throw new ValidationError(`radiusMeters must be at most ${MAX_RADIUS_METERS}`);
  }

  if (!isInNe511Footprint(latitude, longitude)) {
    if (!isHereConfigured()) {
      return { signals: [], networks: [], partial: false, failedNetworks: [], generatedAt: new Date().toISOString() };
    }
    const signals = await getHereIncidents({ latitude, longitude, radiusMeters });
    return { signals, networks: ['HERE'], partial: false, failedNetworks: [], generatedAt: new Date().toISOString() };
  }

  const settled = await Promise.allSettled(NE511_NETWORKS.map(fetchNetworkIncidentsCached));
```
(Everything after this line — the `settled.forEach`/`failedNetworks`/final `return` for the New England 511 path — stays exactly as it is today.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd geocoding-server && node --test test/roadSignalsEndpoint.test.js`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 5: Run the full server test suite to confirm no regressions anywhere else**

Run: `cd geocoding-server && node --test`
Expected: PASS, same total count as before this plan started plus the new tests added across Tasks 2-6 (no failures, no unexpected skips beyond the one pre-existing Windows-only skip).

- [ ] **Step 6: Commit**

```bash
git add geocoding-server/src/roadSignals.js geocoding-server/test/helpers.js geocoding-server/test/roadSignalsEndpoint.test.js
git commit -m "Wire HERE into GET /road-signals as the out-of-footprint provider

Locations inside a Maine/NH/Vermont bounding box keep using New England
511 exactly as before; locations outside it use HERE if HERE_API_KEY is
set, otherwise return an honest empty result. A failed HERE fetch
throws UpstreamError (502), matching New England 511's own
all-networks-failed convention."
```

---

## Self-Review

**Spec coverage:** every section of the spec has a task —
"Verified facts"/endpoint+shape (Tasks 4/5), "Architecture"/shared-module extraction
(Task 1), "Geographic gate" (Task 6), "Severity and hazard-category mapping" (Tasks 2/3),
"Response contract" (Task 6), "Configuration" (Task 2, plus helpers.js in Task 6),
"Explicitly deferred" items (no task needed — deferring is the point), "Testing plan"
(a test step in every task).

**Placeholder scan:** no TBD/TODO/"add appropriate handling" phrasing anywhere above —
every step has real, complete code.

**Type consistency:** `getHereIncidents({ latitude, longitude, radiusMeters })` (Task 5)
matches its call site in Task 6's `roadSignals.js` dispatcher exactly. `isHereConfigured()`
(Task 2) takes no arguments everywhere it's used (Task 6). `normalizeHereIncident(raw)`
(Task 4) takes one raw `results[]` entry, matching how `fetchHereIncidents` (Task 5)
calls it via `.map(normalizeHereIncident)`. `categorizeHazard`/`filterByBbox`/
`sortByFreshness` are imported from `./roadSignalsShared` consistently in both
`roadSignals.js` (Task 1) and `hereTraffic.js` (Tasks 3/5) — never from each other.
