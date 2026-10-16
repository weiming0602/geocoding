# LLM-Assisted Geocoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an authenticated `/geocode` request fails because the address text is malformed (misspelled street, wrong town, missing ZIP) rather than genuinely out of area, use Claude Haiku 4.5 to pick the real street Meridian's own database already has that the caller most likely meant, and retry.

**Architecture:** A pure coverage-area classifier gates the feature to plausible Maine/NH addresses; a Postgres trigram-similarity query pulls real nearby candidate street names from `street_names`; Claude Haiku 4.5, called via forced tool-use (never free text), picks one of those candidates or says "none fit" — it can never invent a street. A picked candidate is re-run through the existing range-interpolation matcher (now extracted into its own module so both the normal path and this retry path share it) to produce a genuine, already-real-data coordinate. Every attempt that reaches the LLM step is logged to a new table.

**Tech Stack:** Node.js/Express, `pg`, Postgres `pg_trgm` extension, Anthropic Messages API (raw `fetch`, no SDK — matches this codebase's existing HERE Traffic/Resend/Nominatim convention of no SDK dependencies for external APIs).

**Spec:** `docs/superpowers/specs/2026-10-15-llm-geocode-assist-design.md`

## Global Constraints

- Forward geocoding only (`POST /geocode`). Reverse geocoding and all three batch endpoints are explicitly untouched — `batchGeocode.js`'s calls into `geocode()` must never pass the new `llmAssist` option (verified by a regression test in Task 6).
- Only authenticated requests (valid `email` + `serviceKey`) ever reach the LLM-assist path. Unauthenticated/free requests get today's plain `NotFoundError`, unchanged.
- The LLM may only select among real candidates already in `street_names` — never free-text generation. Enforced structurally via forced tool-use with a lettered-candidate-only schema, not by prompt instruction alone.
- New env var `ANTHROPIC_API_KEY` (optional). Unset silently disables the whole feature — falls straight through to today's plain 404, exactly as if this plan were never implemented. Same convention as `HERE_API_KEY`/`RESEND_API_KEY`.
- Model: Claude Haiku 4.5, exact model id `claude-haiku-4-5-20251001`.
- Every attempt that reaches the LLM step (passed coverage + auth + had candidates) is logged to a new `llm_geocode_assists` table in `geocoding_users`, reviewed manually via `psql` — no digest, no email.
- Requires the `pg_trgm` Postgres extension on the `geocoding` database — a one-time manual step (`CREATE EXTENSION IF NOT EXISTS pg_trgm;`), same convention as PostGIS/pgRouting documented in `CLAUDE.md`. This plan's final task calls this out explicitly as a deploy prerequisite on `geocoding-test`/`geocoding-prod`.
- Commits are small and single-purpose; imperative present tense, no trailing period (this repo's standing convention).

**Note on a spec imprecision, resolved here:** the spec's architecture diagram says "any of the 3 existing `NotFoundError` cases," but `geocode()` actually has 2 `NotFoundError` throws and 1 separate `OutOfRangeError` throw (street matched by name fine, house number just doesn't fall in any segment's range). This plan triggers the LLM-assist retry only on the two genuine `NotFoundError` cases — a street-name-similarity retry has nothing useful to offer when the street already matched correctly and only the number didn't fit.

**Note on a second spec imprecision, resolved here:** the spec's coverage-guardrail fallback says to check the town against "`street_names`/`address_points`," but `street_names` has no town column at all (confirmed in `schema.py`), and `address_points` only covers Maine (NH has zero E911 address-point coverage, per `CLAUDE.md`'s Known Gaps). This plan's town check queries `address_points.town` only; an inconclusive NH town (or any unrecognized town) falls through to the spec's own explicit "allow anyway" tie-breaker, so the net behavior matches the spec's intent even though only Maine towns are ever positively confirmed.

---

### Task 1: Coverage guardrail

**Files:**
- Create: `geocoding-server/src/geocodeCoverage.js`
- Test: `geocoding-server/test/geocodeCoverage.test.js`

**Interfaces:**
- Produces: `classifyCoverage({ zip, state })` → `'in' | 'out' | 'inconclusive'` (pure, no DB). `isPlausiblyInCoverageArea(db, { zip, state, town })` → `Promise<boolean>` (calls `classifyCoverage` first, only queries `address_points` when inconclusive). Both consumed by Task 5's `llmAssist.js`.

- [ ] **Step 1: Write the failing tests**

Create `geocoding-server/test/geocodeCoverage.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyCoverage, isPlausiblyInCoverageArea } = require('../src/geocodeCoverage');
const { makeDb } = require('./helpers');

test('classifyCoverage: 2-letter ME state code is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'ME' }), 'in');
});

test('classifyCoverage: 2-letter NH state code is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'NH' }), 'in');
});

test('classifyCoverage: full state name "Maine" is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'Maine' }), 'in');
});

test('classifyCoverage: full state name "New Hampshire" is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'New Hampshire' }), 'in');
});

test('classifyCoverage: an explicit non-ME/NH 2-letter state code is out of range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'TX' }), 'out');
});

test('classifyCoverage: an explicit non-ME/NH full state name is out of range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'Texas' }), 'out');
});

test('classifyCoverage: a ZIP in the ME prefix range (039-049) is in range when no state given', () => {
  assert.equal(classifyCoverage({ zip: '04091', state: null }), 'in');
});

test('classifyCoverage: a ZIP in the NH prefix range (030-038) is in range when no state given', () => {
  assert.equal(classifyCoverage({ zip: '03301', state: null }), 'in');
});

test('classifyCoverage: a ZIP outside the ME/NH prefix ranges is out of range when no state given', () => {
  assert.equal(classifyCoverage({ zip: '78701', state: null }), 'out'); // Austin, TX
});

test('classifyCoverage: state takes priority over a contradicting ZIP', () => {
  // Deliberately inconsistent input -- state is the stronger, more explicit signal.
  assert.equal(classifyCoverage({ zip: '78701', state: 'ME' }), 'in');
});

test('classifyCoverage: neither state nor zip is inconclusive', () => {
  assert.equal(classifyCoverage({ zip: null, state: null }), 'inconclusive');
});

test('isPlausiblyInCoverageArea: returns true immediately for an in-range ZIP without touching the DB', async () => {
  const db = { query: () => { throw new Error('should not be called'); } };
  const result = await isPlausiblyInCoverageArea(db, { zip: '04091', state: null, town: null });
  assert.equal(result, true);
});

test('isPlausiblyInCoverageArea: returns false immediately for an explicit out-of-range state without touching the DB', async () => {
  const db = { query: () => { throw new Error('should not be called'); } };
  const result = await isPlausiblyInCoverageArea(db, { zip: null, state: 'TX', town: null });
  assert.equal(result, false);
});

test('isPlausiblyInCoverageArea: inconclusive + town matches a real Maine town in address_points -> true', async () => {
  const db = await makeDb();
  try {
    // "Standish" is seeded by seedFixtureStreets() via the test-uid-2 address_points row.
    const result = await isPlausiblyInCoverageArea(db, { zip: null, state: null, town: 'Standish' });
    assert.equal(result, true);
  } finally {
    await db.close();
  }
});

test('isPlausiblyInCoverageArea: inconclusive + unrecognized town falls through to true anyway (false negatives cost more than the rare wasted LLM call)', async () => {
  const db = await makeDb();
  try {
    const result = await isPlausiblyInCoverageArea(db, { zip: null, state: null, town: 'Nowhereville' });
    assert.equal(result, true);
  } finally {
    await db.close();
  }
});

test('isPlausiblyInCoverageArea: inconclusive + no town at all also falls through to true', async () => {
  const db = await makeDb();
  try {
    const result = await isPlausiblyInCoverageArea(db, { zip: null, state: null, town: null });
    assert.equal(result, true);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd geocoding-server && node --test test/geocodeCoverage.test.js`
Expected: FAIL — `Cannot find module '../src/geocodeCoverage'`

- [ ] **Step 3: Write `geocodeCoverage.js`**

Create `geocoding-server/src/geocodeCoverage.js`:

```js
// ME ZIP codes start 039-049; NH ZIP codes start 030-038. Both ranges
// are contiguous, so one bounds check covers both states at once.
const ZIP_PREFIX_MIN = 30;
const ZIP_PREFIX_MAX = 49;

const ME_NH_STATE_ABBRS = new Set(['ME', 'NH']);
const ME_NH_STATE_NAMES = new Set(['MAINE', 'NEW HAMPSHIRE']);

/**
 * Classifies, from state/zip alone (no DB access, no network), whether a
 * parsed address is plausibly within Meridian's Maine/New Hampshire
 * coverage area. Returns 'in' | 'out' | 'inconclusive'.
 *
 * An explicit state is the strongest signal and is checked first, ahead
 * of a ZIP that might contradict it -- a caller who typed a real state
 * code almost certainly meant it, even if they fat-fingered the ZIP.
 */
function classifyCoverage({ zip, state }) {
  if (state) {
    const normalized = state.toUpperCase();
    if (state.length === 2) {
      return ME_NH_STATE_ABBRS.has(normalized) ? 'in' : 'out';
    }
    return ME_NH_STATE_NAMES.has(normalized) ? 'in' : 'out';
  }

  if (zip) {
    const prefix = parseInt(zip.slice(0, 3), 10);
    if (Number.isNaN(prefix)) return 'inconclusive';
    return prefix >= ZIP_PREFIX_MIN && prefix <= ZIP_PREFIX_MAX ? 'in' : 'out';
  }

  return 'inconclusive';
}

/**
 * Full coverage check, including the DB-backed town fallback for the
 * 'inconclusive' case (no state, no zip, or an unparseable zip) -- checks
 * the given town against address_points.town. address_points is Maine E911
 * data only (NH has zero address-point coverage, confirmed in CLAUDE.md's
 * Known Gaps), so an inconclusive NH town -- or any town we simply don't
 * recognize -- falls through to the same "allow" default as a town with
 * no match at all: false negatives here (skipping a legitimately fixable
 * ME/NH address) cost more than the rare false positive of one wasted LLM
 * call on an address that turns out to be elsewhere.
 */
async function isPlausiblyInCoverageArea(db, { zip, state, town }) {
  const classified = classifyCoverage({ zip, state });
  if (classified === 'in') return true;
  if (classified === 'out') return false;

  if (town) {
    const { rows } = await db.query('SELECT 1 FROM address_points WHERE UPPER(town) = UPPER($1) LIMIT 1', [town]);
    if (rows.length > 0) return true;
  }

  return true;
}

module.exports = { classifyCoverage, isPlausiblyInCoverageArea };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd geocoding-server && node --test test/geocodeCoverage.test.js`
Expected: PASS, all 16 tests.

- [ ] **Step 5: Commit**

```bash
cd geocoding-server
git add src/geocodeCoverage.js test/geocodeCoverage.test.js
git commit -m "Add the Maine/NH coverage guardrail for LLM-assisted geocoding"
```

---

### Task 2: Trigram candidate retrieval + matching-helpers extraction

**Files:**
- Create: `geocoding-server/src/geocodeMatching.js`
- Modify: `geocoding-server/src/geocode.js` (remove `candidateStreets`, `matchAddressPoint`, and the range-interpolation body of `geocode()`, replacing them with requires from `geocodeMatching.js` — see Step 3)
- Modify: `geocoding-server/test/helpers.js:53` (`createTestDatabase`'s extension setup)
- Modify: `geocoding/schema.py:11-16` (docstring), `geocoding/schema.py:158-186` (`CREATE_STREET_NAMES_INDEXES_SQL`)
- Test: `geocoding-server/test/geocodeCandidates.test.js`

**Interfaces:**
- Produces: `geocodeMatching.js` exports `candidateStreets`, `matchAddressPoint` (moved verbatim, unchanged behavior), `matchByStreetAndZip(db, number, streetName, zip, state, offsetFeet)` → the shared range-interpolation result shape `{ match, source: 'interpolation', rangeSide, offsetSide, offsetFeet, coordinates }` (extracted from `geocode()`'s body, unchanged logic), and the new `candidateStreetNames(db, streetName, { zip, state })` → `Promise<Array<{ fullname, zipl, zipr, state_abbr }>>`.
- Consumes (Task 5): Task 5's `llmAssist.js` requires `candidateStreetNames` and `matchByStreetAndZip` from this module — **not** from `geocode.js` — specifically to avoid a circular require (`geocode.js` will itself require `llmAssist.js` in Task 5).

**Why this extraction, not just a new function:** `llmAssist.js` (Task 5) needs to call the same range-interpolation logic `geocode()` already uses, to turn an LLM-picked candidate into real coordinates. If that logic stayed inside `geocode.js` and `llmAssist.js` imported it from there, `geocode.js` importing `llmAssist.js` back (to call it from its own failure path) would create a circular require. Moving the shared matching primitives into their own leaf module (depended on by both, depending on neither) avoids this entirely — consistent with this codebase's existing pattern of small single-responsibility files (`parseAddress.js`, `streetSuffixes.js`, `interpolate.py` are all already split out this way).

This task is a **pure refactor plus one new addition** — `geocode()`'s observable behavior must not change at all. The existing `geocode.test.js` suite (which exercises `geocode()` end-to-end, not `candidateStreets`/`matchAddressPoint` directly) is the safety net: it must pass identically before and after.

- [ ] **Step 1: Run the existing geocode test suite to record the baseline**

Run: `cd geocoding-server && node --test test/geocode.test.js`
Expected: PASS (note the exact test count — you'll re-run this after the refactor and it must match exactly).

- [ ] **Step 2: Write the failing test for the new candidate-retrieval query**

Create `geocoding-server/test/geocodeCandidates.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { candidateStreetNames } = require('../src/geocodeMatching');
const { makeDb } = require('./helpers');

test('candidateStreetNames: a misspelled street name in a known ZIP surfaces the real street', async () => {
  const db = await makeDb();
  try {
    // "Pequawket Trl" is seeded at ZIP 04091 (id=12/14) -- "Peqwket Trl"
    // (missing the second "a") should still surface it via trigram
    // similarity.
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: '04091', state: null });
    assert.ok(candidates.some((c) => c.fullname === 'Pequawket Trl'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: scoped by ZIP, a street in a different ZIP is not returned', async () => {
  const db = await makeDb();
  try {
    // "Sebago Rd" lives at ZIP 04074, not 04091 -- a ZIP-scoped search for
    // something near "Pequawket" shouldn't surface it.
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: '04091', state: null });
    assert.ok(!candidates.some((c) => c.fullname === 'Sebago Rd'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: with no ZIP but a state, scopes to that state', async () => {
  const db = await makeDb();
  try {
    // id=99 is "Pequawket Trl" in NH (same name/zip as the ME rows,
    // deliberately, to test state disambiguation) -- a state-scoped
    // search for NH should surface only the NH row's fullname, not
    // silently also match on the ME rows sharing the same name.
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: null, state: 'NH' });
    assert.ok(candidates.some((c) => c.fullname === 'Pequawket Trl' && c.state_abbr === 'NH'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: with neither ZIP nor state, scopes to ME/NH only', async () => {
  const db = await makeDb();
  try {
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: null, state: null });
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((c) => c.state_abbr === 'ME' || c.state_abbr === 'NH'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: a wildly dissimilar name returns no candidates', async () => {
  const db = await makeDb();
  try {
    const candidates = await candidateStreetNames(db, 'Zzyzx Quantum Boulevard', { zip: '04091', state: null });
    assert.equal(candidates.length, 0);
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: results are ordered most-similar first', async () => {
  const db = await makeDb();
  try {
    const candidates = await candidateStreetNames(db, 'Pequawket Trl', { zip: '04091', state: null });
    // The exact name should be the top (or tied-top) result.
    assert.equal(candidates[0].fullname, 'Pequawket Trl');
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 3: Run the new test to verify it fails**

Run: `cd geocoding-server && node --test test/geocodeCandidates.test.js`
Expected: FAIL — `Cannot find module '../src/geocodeMatching'`

- [ ] **Step 4: Enable `pg_trgm` in the test database bootstrap**

Modify `geocoding-server/test/helpers.js`, the `createTestDatabase` function signature and extension block (currently lines 53-67):

```js
async function createTestDatabase({ postgis = true, pgrouting = false, trgm = true } = {}) {
  const name = `geocoding_test_${crypto.randomBytes(8).toString('hex')}`;

  const admin = new Pool({ connectionString: ADMIN_DSN });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dsn = `postgresql://my_ai@${SOCKET_HOST}/${name}`;
  const pool = new Pool({ connectionString: dsn });
  if (postgis) {
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
  }
  if (pgrouting) {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgrouting');
  }
  if (trgm) {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  }
```

(Only the signature's default-parameter list and the new `if (trgm)` block are additions — everything else in the function is unchanged. `trgm` defaults to `true`, same as `postgis`, since it's a lightweight extension every test database can safely have available, flowing through automatically to `makeDb()`/`makeFixtureDsn()`/`withTestServer()` with no further plumbing needed.)

- [ ] **Step 5: Create `geocodeMatching.js`**

Create `geocoding-server/src/geocodeMatching.js` — this moves `candidateStreets` and `matchAddressPoint` out of `geocode.js` **verbatim** (identical code, identical doc comments), extracts the range-interpolation body of `geocode()` into `matchByStreetAndZip`, and adds the new `candidateStreetNames`:

```js
const { parseLinestring, interpolateAlongLine } = require('./interpolate');
const { expandStreetSuffix, abbreviateStreetSuffix } = require('./streetSuffixes');
const { NotFoundError, OutOfRangeError } = require('./errors');

/**
 * Finds every streets row known by `streetName` — checking not just its
 * primary fullname but every alternate name TIGER records for that TLID
 * in street_names (e.g. "Pequawket Trl" and "State Rte 113" can be the
 * same physical segment) — matching the given side's ZIP (zipl for odd
 * house numbers, zipr for even — TIGER edges can have a different ZIP on
 * each side of the same segment), and (if provided) state. A 2-letter
 * state is matched against state_abbr; anything else against the full
 * state name. A single named street is typically split into many `edges`
 * segments, each covering a different address sub-range, so callers must
 * pick the segment whose range actually contains the target number.
 *
 * Also tries `streetName` with its suffix abbreviated (e.g. "Pequawket
 * Trail" -> "Pequawket Trl") alongside the name as given: TIGER's own
 * street_names.fullname always stores the abbreviated form, unlike Maine's
 * E911 address_points (which matchAddressPoint already handles both
 * directions for), so a caller who spells the suffix out in full would
 * otherwise never match here at all. abbreviateStreetSuffix is a no-op
 * when the input isn't a recognized full suffix name (including when
 * it's already abbreviated), so trying both is always safe.
 */
async function candidateStreets(db, streetName, zip, zipColumn, state) {
  if (zipColumn !== 'zipl' && zipColumn !== 'zipr') {
    throw new Error(`zipColumn must be 'zipl' or 'zipr', got ${zipColumn}`);
  }
  const stateColumn = state && state.length === 2 ? 'state_abbr' : 'state';
  const stateClause = state ? `AND UPPER(street_names.${stateColumn}) = UPPER($4)` : '';
  const stateParam = state ? [state] : [];
  const abbreviated = abbreviateStreetSuffix(streetName);

  // Driving the query from street_names (filtered by its own
  // UPPER(fullname)+zip+state composite index) rather than from streets
  // matters: street_names carries denormalized copies of zipl/zipr/state
  // for exactly this reason (see schema.py). Filtering streets first and
  // joining to street_names per matched row turns into a per-row nested
  // lookup for every segment in the ZIP -- measured ~15x slower at batch
  // scale. Filtering street_names first hits its composite index directly
  // and only touches streets (via its unique tlid index) for the few rows
  // that actually match.
  const buildQuery = (nameClause) => `
    SELECT DISTINCT streets.* FROM street_names
    JOIN streets ON streets.tlid = street_names.tlid
    WHERE ${nameClause} AND street_names.${zipColumn} = $3 ${stateClause}
  `;

  const exact = await db.query(
    buildQuery('UPPER(street_names.fullname) IN (UPPER($1), UPPER($2))'),
    [streetName, abbreviated, zip, ...stateParam]
  );
  if (exact.rows.length > 0) return exact.rows;

  const fallback = await db.query(
    buildQuery('(UPPER(street_names.fullname) LIKE UPPER($1) OR UPPER(street_names.fullname) LIKE UPPER($2))'),
    [`%${streetName}%`, `%${abbreviated}%`, zip, ...stateParam]
  );
  return fallback.rows;
}

/**
 * Prototype: looks for an exact real-world location in Maine's E911
 * address_points table (see ingest_address_points.py) before ever
 * falling back to range-interpolation. Where a point exists, it's simply
 * more accurate -- range-interpolation assumes house numbers are evenly
 * spaced along a segment, which is often false on long rural roads with
 * a handful of widely-spaced houses.
 *
 * address_points is keyed by town, not ZIP (that's what Maine's E911
 * data carries; ZIP is a TIGER/USPS concept, not a NENA one), so this
 * matches on street name + house number, narrowed by town when the
 * caller's address included one (see parseAddress.js). Without a town,
 * multiple same-named-street-and-number matches across different towns
 * can't be disambiguated safely, so an ambiguous no-town match is
 * treated as no match at all rather than guessing.
 *
 * A 2-letter state, when given, is checked directly against the
 * matched point's own state_abbr. ZIP has no column on address_points
 * to check directly -- instead it's cross-checked against street_names'
 * zipl/zipr for this street name (the same TIGER data candidateStreets
 * uses below), but only when TIGER actually has an opinion: if this
 * street name has no street_names entry at all (real for streets E911
 * covers that TIGER doesn't -- see the "Test Point Lane" fixture in
 * test/helpers.js), there's nothing to contradict the caller's ZIP with,
 * so it's left unchecked rather than rejecting a match TIGER simply
 * has no data on. When street_names *does* have this street under a
 * completely different set of ZIPs, that's real contradicting evidence
 * (a typo, or the same street name in a different town) -- the match is
 * treated as no match instead of accepted with full confidence, falling
 * through to the interpolation path, which does validate ZIP directly.
 */
async function matchAddressPoint(db, number, streetName, town, zip, state) {
  // TIGER-style input abbreviates suffixes ("Dr"); Maine's E911 data
  // spells them out ("Drive") -- try both so neither style is required.
  const expanded = expandStreetSuffix(streetName);
  const townClause = town ? 'AND UPPER(town) = UPPER($4)' : '';
  const params = town ? [streetName, expanded, number, town] : [streetName, expanded, number];

  const { rows } = await db.query(
    `SELECT id, site_uid, street_fullname, town, county, state_abbr, ST_X(geom) AS longitude, ST_Y(geom) AS latitude
     FROM address_points
     WHERE UPPER(street_fullname) IN (UPPER($1), UPPER($2)) AND address_number = $3 ${townClause}`,
    params
  );

  if (rows.length !== 1) return null; // no match, or ambiguous across towns with no town given
  const point = rows[0];

  if (state && state.length === 2 && point.state_abbr && point.state_abbr.toUpperCase() !== state.toUpperCase()) {
    return null;
  }

  if (zip) {
    const { rows: zipCheckRows } = await db.query(
      `SELECT
         count(*) > 0 AS street_known,
         count(*) FILTER (WHERE zipl = $3 OR zipr = $3) > 0 AS zip_matches
       FROM street_names
       WHERE UPPER(fullname) IN (UPPER($1), UPPER($2))`,
      [streetName, expanded, zip]
    );
    const { street_known, zip_matches } = zipCheckRows[0];
    if (street_known && !zip_matches) return null;
  }

  return point;
}

/**
 * Finishes a geocode once a street name + ZIP are known to be correct —
 * either the caller's own parsed input (geocode.js's normal path), or an
 * LLM-corrected candidate pulled from real street_names data
 * (llmAssist.js's retry path). Shared by both so the range/interpolation
 * math exists in exactly one place. Extracted verbatim from geocode()'s
 * own body — behavior is unchanged from before this extraction.
 */
async function matchByStreetAndZip(db, number, streetName, zip, state, offsetFeet) {
  const rangeSide = number % 2 === 1 ? 'left' : 'right';
  const offsetSide = rangeSide;
  const [fromCol, toCol] = rangeSide === 'left' ? ['lfromadd', 'ltoadd'] : ['rfromadd', 'rtoadd'];
  const zipColumn = rangeSide === 'left' ? 'zipl' : 'zipr';

  const candidates = await candidateStreets(db, streetName, zip, zipColumn, state);
  if (candidates.length === 0) {
    const stateSuffix = state ? ` (state ${state})` : '';
    throw new NotFoundError(`no street found matching "${streetName}" in ZIP ${zip}${stateSuffix}`);
  }

  let matchedRow = null;
  let fraction = null;
  for (const row of candidates) {
    const fromRaw = row[fromCol];
    const toRaw = row[toCol];
    if (!fromRaw || !toRaw) continue;
    const fromNum = parseInt(fromRaw, 10);
    const toNum = parseInt(toRaw, 10);
    const lo = Math.min(fromNum, toNum);
    const hi = Math.max(fromNum, toNum);
    if (number >= lo && number <= hi) {
      matchedRow = row;
      fraction = (number - fromNum) / (toNum - fromNum);
      break;
    }
  }

  if (!matchedRow) {
    throw new OutOfRangeError(
      `no "${streetName}" segment in ZIP ${zip} has a ${rangeSide} range containing ${number} ` +
        `(${candidates.length} segment(s) found for this street/ZIP, none cover that number)`
    );
  }

  const points = parseLinestring(matchedRow.geometry);
  const [longitude, latitude] = interpolateAlongLine(points, fraction, offsetFeet, offsetSide);

  const match = {
    id: matchedRow.id,
    tlid: matchedRow.tlid,
    fullname: matchedRow.fullname,
    zipl: matchedRow.zipl,
    zipr: matchedRow.zipr,
  };
  if (state) {
    if (state.length === 2) {
      match.state_abbr = matchedRow.state_abbr;
    } else {
      match.state = matchedRow.state;
    }
  }

  return {
    match,
    source: 'interpolation',
    rangeSide,
    offsetSide,
    offsetFeet,
    coordinates: { latitude, longitude },
  };
}

const CANDIDATE_SIMILARITY_THRESHOLD = 0.3;
const MAX_CANDIDATES = 10;

/**
 * Finds real nearby street names by trigram spelling similarity, for
 * llmAssist.js to offer an LLM as pick-from candidates when the normal
 * exact/LIKE matching in candidateStreets() above found nothing. Scoped
 * as tightly as the input allows: by ZIP when given (strongest signal —
 * street_names has no town column, so ZIP is the closest we get to "the
 * same neighborhood"), else by state when given, else to ME/NH broadly
 * (this function is only ever called after isPlausiblyInCoverageArea()
 * has already confirmed the input belongs in that universe). Requires
 * the pg_trgm extension (CREATE EXTENSION IF NOT EXISTS pg_trgm) --
 * see geocoding/schema.py and this repo's CLAUDE.md for the one-time
 * manual setup step this needs on a real database.
 *
 * CANDIDATE_SIMILARITY_THRESHOLD (0.3) is a starting value, not
 * empirically tuned yet -- adjust once real misspelled-address examples
 * are available in production.
 */
async function candidateStreetNames(db, streetName, { zip, state } = {}) {
  const params = [streetName, CANDIDATE_SIMILARITY_THRESHOLD];
  let scopeClause;
  if (zip) {
    scopeClause = 'AND (zipl = $3 OR zipr = $3)';
    params.push(zip);
  } else if (state) {
    const stateColumn = state.length === 2 ? 'state_abbr' : 'state';
    scopeClause = `AND UPPER(${stateColumn}) = UPPER($3)`;
    params.push(state);
  } else {
    scopeClause = `AND UPPER(state_abbr) IN ('ME', 'NH')`;
  }

  const { rows } = await db.query(
    `SELECT DISTINCT fullname, zipl, zipr, state_abbr, similarity(UPPER(fullname), UPPER($1)) AS sim
     FROM street_names
     WHERE similarity(UPPER(fullname), UPPER($1)) > $2 ${scopeClause}
     ORDER BY sim DESC
     LIMIT ${MAX_CANDIDATES}`,
    params
  );
  return rows;
}

module.exports = { candidateStreets, matchAddressPoint, matchByStreetAndZip, candidateStreetNames };
```

- [ ] **Step 6: Update `geocode.js` to use the extracted module**

Replace the full contents of `geocoding-server/src/geocode.js` with:

```js
const { parseAddress } = require('./parseAddress');
const { NotFoundError } = require('./errors');
const { matchAddressPoint, matchByStreetAndZip } = require('./geocodeMatching');

/**
 * Resolves a free-text address to coordinates using the local `streets`
 * table: odd house numbers interpolate against the left range
 * (lfromadd/ltoadd), match on zipl, and are offset left of the
 * centerline; even house numbers use the right range (rfromadd/rtoadd),
 * match on zipr, and are offset right.
 */
async function geocode(db, addressInput, { offsetFeet = 20 } = {}) {
  const { number, streetName, zip, state, town } = parseAddress(addressInput);

  const addressPoint = await matchAddressPoint(db, number, streetName, town, zip, state);
  if (addressPoint) {
    return {
      input: { number, streetName, zip, state, town },
      match: {
        siteUid: addressPoint.site_uid,
        fullname: addressPoint.street_fullname,
        town: addressPoint.town,
        county: addressPoint.county,
        state_abbr: addressPoint.state_abbr,
      },
      source: 'address_point',
      coordinates: { latitude: addressPoint.latitude, longitude: addressPoint.longitude },
    };
  }

  // No exact address-point match, and no ZIP to fall back on -- unlike
  // matchAddressPoint (keyed by town), candidateStreets has no town/city
  // column to filter by at all (TIGER's street_names only carries
  // zipl/zipr/state), so a common street name has no other way to be
  // disambiguated here. Caught explicitly, with a message naming the
  // actual problem, rather than letting `street_names.zipColumn = NULL`
  // silently match nothing and surface as a confusing "in ZIP null".
  if (!zip) {
    throw new NotFoundError(
      `could not find an exact address match for "${streetName}" in ${town ?? 'the given town'} -- ` +
        'add a ZIP code to search by street range instead'
    );
  }

  const result = await matchByStreetAndZip(db, number, streetName, zip, state, offsetFeet);
  return { input: { number, streetName, zip, state, town }, ...result };
}

module.exports = { geocode };
```

(Task 5 will modify this file again to add the LLM-assist retry — this step is purely the extraction, with `geocode()`'s observable behavior identical to before. Note `candidateStreets`/`matchAddressPoint` are no longer exported from `geocode.js` at all now — nothing outside this file imported them before this change, so this is safe. If Step 7 below reveals a test elsewhere that did import them directly from `geocode.js`, re-export them from `geocode.js` too via `const { candidateStreets, matchAddressPoint } = require('./geocodeMatching'); module.exports = { geocode, candidateStreets, matchAddressPoint };` instead.)

- [ ] **Step 7: Run the full geocode test suite to confirm zero behavior change**

Run: `cd geocoding-server && node --test test/geocode.test.js`
Expected: PASS, with the **exact same test count** as Step 1's baseline. If anything fails, this extraction introduced a behavior change — stop and fix it before proceeding (do not paper over a failure here).

- [ ] **Step 8: Run the new candidate-retrieval test to verify it passes**

Run: `cd geocoding-server && node --test test/geocodeCandidates.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 9: Add the `pg_trgm` extension and GIN index to the real ingest schema**

Modify `geocoding/schema.py`. In the module docstring (currently lines 11-16):

```python
Requires the `postgis` extension (CREATE EXTENSION IF NOT EXISTS postgis;
run once per database -- see the one-time setup in the migration docs).
Routing (see routing_topology.py) additionally requires `pgrouting`
(`sudo apt install postgresql-18-pgrouting`, then
CREATE EXTENSION IF NOT EXISTS pgrouting; -- also a one-time, manual step).
LLM-assisted geocoding's candidate-street lookup (see geocoding-server/src/
geocodeMatching.js's candidateStreetNames) additionally requires `pg_trgm`
(CREATE EXTENSION IF NOT EXISTS pg_trgm; -- same one-time, manual pattern).
```

Then, at the end of `CREATE_STREET_NAMES_INDEXES_SQL` (currently closing at line 186), add one more index before the closing `"""`:

```python
CREATE_STREET_NAMES_INDEXES_SQL = """
-- (existing content above unchanged)
CREATE INDEX IF NOT EXISTS idx_street_names_zipl_zipr ON street_names (zipl, zipr);
CREATE INDEX IF NOT EXISTS idx_street_names_zipr_zipl ON street_names (zipr, zipl);
-- Trigram index for LLM-assisted geocoding's candidate-street lookup
-- (geocodeMatching.js's candidateStreetNames) -- without this, a
-- similarity() query against fullname is a full table scan every time.
-- Requires the pg_trgm extension (see this file's module docstring).
CREATE INDEX IF NOT EXISTS idx_street_names_fullname_trgm
    ON street_names USING GIN (fullname gin_trgm_ops);
"""
```

This constant is already executed by `ingest_featnames.py` and `migrate_to_postgres.py` (both `require`/`import` it from `schema.py`), so no other Python file needs to change — the new index is picked up automatically the next time either of those runs. This is documentation + a schema addition only; it does not run against any real database as part of this plan (same as PostGIS/pgRouting's own manual-step convention) — Task 6's final-verification checklist calls out running it manually on `geocoding-test`/`geocoding-prod`.

- [ ] **Step 10: Commit**

```bash
cd geocoding-server
git add src/geocodeMatching.js src/geocode.js test/helpers.js test/geocodeCandidates.test.js
git add ../geocoding/schema.py
git commit -m "Extract geocode matching helpers and add trigram candidate retrieval"
```

---

### Task 3: Anthropic client

**Files:**
- Create: `geocoding-server/src/anthropicClient.js`
- Test: `geocoding-server/test/anthropicClient.test.js`

**Interfaces:**
- Produces: `isLlmAssistConfigured()` → `boolean`. `pickCandidateWithLlm(originalInput, candidates)` → `Promise<{ picked: object | null, failureReason: 'none_fit' | 'llm_error' | null }>` — `picked` is one of the `candidates` array elements (never a newly-constructed object), or `null`; `failureReason` is `null` only when `picked` is non-null. Never throws. Consumed by Task 5's `llmAssist.js`.

- [ ] **Step 1: Write the failing tests**

Create `geocoding-server/test/anthropicClient.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { isLlmAssistConfigured, pickCandidateWithLlm } = require('../src/anthropicClient');

const CANDIDATES = [
  { fullname: 'Pequawket Trl', zipl: '04091', zipr: '04091', state_abbr: 'ME' },
  { fullname: 'State Rte 113', zipl: '04091', zipr: '04091', state_abbr: 'ME' },
];

test('isLlmAssistConfigured is false when ANTHROPIC_API_KEY is unset', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(isLlmAssistConfigured(), false);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('isLlmAssistConfigured is true when ANTHROPIC_API_KEY is set', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    assert.equal(isLlmAssistConfigured(), true);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

// pickCandidateWithLlm calls the real global fetch, so these tests
// replace it with a fake for the duration of each test and restore it
// afterward -- same technique hereTraffic.test.js already uses for
// HERE's fetch calls.
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

function withApiKey(fn) {
  return async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  };
}

test(
  'pickCandidateWithLlm: picks the candidate the tool-use response names',
  withFakeFetch(
    async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'claude-haiku-4-5-20251001');
      assert.equal(body.tool_choice.type, 'tool');
      assert.equal(body.tool_choice.name, 'pick_candidate');
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
        }),
      };
    },
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, CANDIDATES[0]);
      assert.equal(failureReason, null);
    })
  )
);

test(
  'pickCandidateWithLlm: a second-letter pick resolves to the second candidate',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'B', reason: 'matches the alternate name' } }],
      }),
    }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 State Rt 113, 04091', CANDIDATES);
      assert.equal(picked, CANDIDATES[1]);
      assert.equal(failureReason, null);
    })
  )
);

test(
  'pickCandidateWithLlm: "none" resolves to picked null, failureReason none_fit',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'none', reason: 'nothing plausibly matches' } }],
      }),
    }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('123 Totally Different St, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'none_fit');
    })
  )
);

test(
  'pickCandidateWithLlm: an out-of-range letter resolves to failureReason llm_error, not a thrown error',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'Z', reason: 'oops' } }],
      }),
    }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test(
  'pickCandidateWithLlm: a fetch failure resolves to failureReason llm_error, not a thrown error',
  withFakeFetch(
    () => {
      throw new Error('network down');
    },
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test(
  'pickCandidateWithLlm: a non-2xx response resolves to failureReason llm_error, not a thrown error',
  withFakeFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test(
  'pickCandidateWithLlm: a response with no usable tool_use block resolves to failureReason llm_error',
  withFakeFetch(
    async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'I am confused' }] }) }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test('pickCandidateWithLlm: never calls fetch when ANTHROPIC_API_KEY is unset', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  try {
    const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
    assert.equal(picked, null);
    assert.equal(failureReason, 'llm_error');
  } finally {
    global.fetch = savedFetch;
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd geocoding-server && node --test test/anthropicClient.test.js`
Expected: FAIL — `Cannot find module '../src/anthropicClient'`

- [ ] **Step 3: Write `anthropicClient.js`**

Create `geocoding-server/src/anthropicClient.js`:

```js
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 10000;

/** Whether ANTHROPIC_API_KEY is set -- mirrors hereTraffic.js's isHereConfigured() pattern for an optional paid integration. */
function isLlmAssistConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function describeCandidate(candidate) {
  const zip = candidate.zipl || candidate.zipr;
  const zipPart = zip ? `ZIP ${zip}` : 'no known ZIP';
  const statePart = candidate.state_abbr ? `, ${candidate.state_abbr}` : '';
  return `${candidate.fullname} (${zipPart}${statePart})`;
}

function buildPrompt(originalInput, candidates) {
  const lettered = candidates
    .map((c, i) => `${String.fromCharCode(65 + i)}. ${describeCandidate(c)}`)
    .join('\n');
  return (
    `A caller tried to geocode this address in Maine or New Hampshire, but it ` +
    `didn't match any street exactly:\n\n"${originalInput}"\n\n` +
    `Here are the closest real street names Meridian already has on file nearby:\n${lettered}\n\n` +
    `If one of these is clearly what the caller meant (a misspelling, a wrong ` +
    `town, a missing ZIP), pick its letter. If none of them plausibly match, ` +
    `say "none". Never invent a street name that isn't in this list.`
  );
}

const PICK_CANDIDATE_TOOL = {
  name: 'pick_candidate',
  description: "Pick the lettered candidate that best matches the caller's intended address, or \"none\" if nothing fits.",
  input_schema: {
    type: 'object',
    properties: {
      pick: {
        type: 'string',
        description: 'The letter of the chosen candidate (e.g. "A"), or the literal string "none".',
      },
      reason: {
        type: 'string',
        description: 'One short sentence explaining the choice.',
      },
    },
    required: ['pick', 'reason'],
  },
};

/**
 * Asks Claude Haiku 4.5 to pick which of `candidates` (real street_names
 * rows -- see geocodeMatching.js's candidateStreetNames) the caller most
 * likely meant by `originalInput`, via forced tool-use so the response
 * can only ever be one of the candidates passed in, or the literal
 * "none" -- never a freely-generated street name.
 *
 * Returns { picked, failureReason }: picked is the chosen element of
 * `candidates` (the exact same object, not a copy), or null;
 * failureReason is 'none_fit' | 'llm_error' | null (null only when
 * picked is non-null). Never throws -- every failure mode (unconfigured,
 * timeout, non-2xx response, malformed/missing tool_use block, an
 * out-of-range letter) folds into failureReason: 'llm_error', so a
 * caller's failure path always degrades gracefully.
 */
async function pickCandidateWithLlm(originalInput, candidates) {
  if (!isLlmAssistConfigured()) return { picked: null, failureReason: 'llm_error' };
  if (!candidates || candidates.length === 0) return { picked: null, failureReason: 'llm_error' };

  const body = {
    model: MODEL,
    max_tokens: 300,
    tools: [PICK_CANDIDATE_TOOL],
    tool_choice: { type: 'tool', name: 'pick_candidate' },
    messages: [{ role: 'user', content: buildPrompt(originalInput, candidates) }],
  };

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[anthropicClient] Anthropic API call failed:', err.message);
    return { picked: null, failureReason: 'llm_error' };
  }

  if (!response.ok) {
    console.error(`[anthropicClient] Anthropic API responded with status ${response.status}`);
    return { picked: null, failureReason: 'llm_error' };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error('[anthropicClient] Anthropic API returned unparseable JSON:', err.message);
    return { picked: null, failureReason: 'llm_error' };
  }

  const toolUse = (data.content || []).find((block) => block.type === 'tool_use' && block.name === 'pick_candidate');
  if (!toolUse || !toolUse.input || !toolUse.input.pick) {
    console.error('[anthropicClient] Anthropic API response had no usable pick_candidate tool_use block');
    return { picked: null, failureReason: 'llm_error' };
  }

  const { pick } = toolUse.input;
  if (pick === 'none') return { picked: null, failureReason: 'none_fit' };

  const index = pick.toUpperCase().charCodeAt(0) - 65;
  if (index < 0 || index >= candidates.length) {
    console.error(`[anthropicClient] Anthropic picked an out-of-range letter: ${pick}`);
    return { picked: null, failureReason: 'llm_error' };
  }

  return { picked: candidates[index], failureReason: null };
}

module.exports = { isLlmAssistConfigured, pickCandidateWithLlm, buildPrompt, describeCandidate };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd geocoding-server && node --test test/anthropicClient.test.js`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Commit**

```bash
cd geocoding-server
git add src/anthropicClient.js test/anthropicClient.test.js
git commit -m "Add the Anthropic tool-use client for LLM-assisted geocoding"
```

---

### Task 4: Logging table

**Files:**
- Create: `geocoding-server/src/llmGeocodeAssists.js`
- Test: `geocoding-server/test/llmGeocodeAssists.test.js`

**Interfaces:**
- Produces: `ensureLlmGeocodeAssistsTable(pool)` → `Promise<void>`. `logLlmGeocodeAssist(pool, { email, originalInput, candidates, picked, succeeded, failureReason })` → `Promise<void>` — `candidates` is the raw array from `candidateStreetNames` (Task 2), serialized to JSON internally; `picked` is a human-readable string (or `null`), not a raw candidate row. Consumed by Task 5's `llmAssist.js`.

- [ ] **Step 1: Write the failing tests**

Create `geocoding-server/test/llmGeocodeAssists.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureLlmGeocodeAssistsTable, logLlmGeocodeAssist } = require('../src/llmGeocodeAssists');
const { makeUsersDb } = require('./helpers');

const SAMPLE_CANDIDATES = [
  { fullname: 'Pequawket Trl', zipl: '04091', zipr: '04091', state_abbr: 'ME' },
];

test('ensureLlmGeocodeAssistsTable is idempotent -- safe to call twice', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await ensureLlmGeocodeAssistsTable(db);
    const { rows } = await db.query('SELECT count(*) FROM llm_geocode_assists');
    assert.equal(rows[0].count, '0');
  } finally {
    await db.close();
  }
});

test('logLlmGeocodeAssist: a successful attempt records picked + succeeded true + no failure_reason', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: '997 Peqwket Trl, 04091',
      candidates: SAMPLE_CANDIDATES,
      picked: 'Pequawket Trl (ZIP 04091, ME)',
      succeeded: true,
      failureReason: null,
    });
    const { rows } = await db.query('SELECT * FROM llm_geocode_assists');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, 'demo@example.com');
    assert.equal(rows[0].original_input, '997 Peqwket Trl, 04091');
    assert.deepEqual(rows[0].candidates_considered, SAMPLE_CANDIDATES);
    assert.equal(rows[0].picked, 'Pequawket Trl (ZIP 04091, ME)');
    assert.equal(rows[0].succeeded, true);
    assert.equal(rows[0].failure_reason, null);
    assert.ok(rows[0].created_at);
  } finally {
    await db.close();
  }
});

test('logLlmGeocodeAssist: a failed attempt (none fit) records picked null + succeeded false + failure_reason', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: '123 Totally Different St, 04091',
      candidates: SAMPLE_CANDIDATES,
      picked: null,
      succeeded: false,
      failureReason: 'none_fit',
    });
    const { rows } = await db.query('SELECT * FROM llm_geocode_assists');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].picked, null);
    assert.equal(rows[0].succeeded, false);
    assert.equal(rows[0].failure_reason, 'none_fit');
  } finally {
    await db.close();
  }
});

test('logLlmGeocodeAssist: multiple attempts from the same email all persist independently', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: 'first attempt',
      candidates: SAMPLE_CANDIDATES,
      picked: null,
      succeeded: false,
      failureReason: 'llm_error',
    });
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: 'second attempt',
      candidates: SAMPLE_CANDIDATES,
      picked: 'Pequawket Trl (ZIP 04091, ME)',
      succeeded: true,
      failureReason: null,
    });
    const { rows } = await db.query('SELECT original_input FROM llm_geocode_assists ORDER BY id');
    assert.deepEqual(rows.map((r) => r.original_input), ['first attempt', 'second attempt']);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd geocoding-server && node --test test/llmGeocodeAssists.test.js`
Expected: FAIL — `Cannot find module '../src/llmGeocodeAssists'`

- [ ] **Step 3: Write `llmGeocodeAssists.js`**

Create `geocoding-server/src/llmGeocodeAssists.js`:

```js
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS llm_geocode_assists (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  original_input TEXT NOT NULL,
  candidates_considered JSONB NOT NULL,
  picked TEXT,
  succeeded BOOLEAN NOT NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function ensureLlmGeocodeAssistsTable(pool) {
  await pool.query(CREATE_TABLE_SQL);
}

/**
 * Logs one LLM-assisted geocode attempt -- called by llmAssist.js for
 * every attempt that reaches the LLM step (passed the coverage check,
 * was authenticated, and had at least one real candidate). Reviewed
 * manually via psql, same convention as feedback.js's table -- no
 * listing/review endpoint, no digest.
 */
async function logLlmGeocodeAssist(pool, { email, originalInput, candidates, picked, succeeded, failureReason }) {
  await pool.query(
    `INSERT INTO llm_geocode_assists (email, original_input, candidates_considered, picked, succeeded, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [email, originalInput, JSON.stringify(candidates), picked, succeeded, failureReason]
  );
}

module.exports = { ensureLlmGeocodeAssistsTable, logLlmGeocodeAssist };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd geocoding-server && node --test test/llmGeocodeAssists.test.js`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
cd geocoding-server
git add src/llmGeocodeAssists.js test/llmGeocodeAssists.test.js
git commit -m "Add the llm_geocode_assists logging table"
```

---

### Task 5: Orchestration — `llmAssist.js` and wiring into `geocode()`

**Files:**
- Create: `geocoding-server/src/llmAssist.js`
- Modify: `geocoding-server/src/geocode.js` (add the `llmAssist` option and retry wiring)
- Test: `geocoding-server/test/llmAssist.test.js`

**Interfaces:**
- Consumes: `isPlausiblyInCoverageArea` (Task 1, `geocodeCoverage.js`); `candidateStreetNames`, `matchByStreetAndZip` (Task 2, `geocodeMatching.js`); `isLlmAssistConfigured`, `pickCandidateWithLlm`, `describeCandidate` (Task 3, `anthropicClient.js`); `logLlmGeocodeAssist` (Task 4, `llmGeocodeAssists.js`).
- Produces: `attemptLlmAssist(db, { usersDb, email }, parsed, originalInput, offsetFeet)` → `Promise<geocodeResult | null>`, where `geocodeResult` has the same shape `matchByStreetAndZip` returns, plus `source: 'llm_assisted'`, `originalInput`, `correctedAddress`. Consumed by Task 6's `server.js` wiring indirectly, via `geocode()`'s new `llmAssist` option.

- [ ] **Step 1: Write the failing tests**

Create `geocoding-server/test/llmAssist.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { attemptLlmAssist } = require('../src/llmAssist');
const { makeDb, makeUsersDb } = require('./helpers');
const { parseAddress } = require('../src/parseAddress');

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

function withApiKey(fn) {
  return async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  };
}

test('attemptLlmAssist returns null without calling fetch when unconfigured', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  const db = await makeDb();
  const usersDb = await makeUsersDb();
  try {
    const parsed = parseAddress('997 Peqwket Trl, 04091');
    const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
    assert.equal(result, null);
  } finally {
    global.fetch = savedFetch;
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    await db.close();
    await usersDb.close();
  }
});

test('attemptLlmAssist returns null without calling fetch for an out-of-coverage address', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  const db = await makeDb();
  const usersDb = await makeUsersDb();
  try {
    await withApiKey(async () => {
      const parsed = parseAddress('123 Main St, Austin, TX 78701');
      const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '123 Main St, Austin, TX 78701', 20);
      assert.equal(result, null);
    })();
  } finally {
    global.fetch = savedFetch;
    await db.close();
    await usersDb.close();
  }
});

test('attemptLlmAssist returns null without calling fetch when there are no real candidates nearby', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  const db = await makeDb();
  const usersDb = await makeUsersDb();
  try {
    await withApiKey(async () => {
      const parsed = parseAddress('42 Zzyzx Quantum Blvd, 04091');
      const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '42 Zzyzx Quantum Blvd, 04091', 20);
      assert.equal(result, null);
    })();
  } finally {
    global.fetch = savedFetch;
    await db.close();
    await usersDb.close();
  }
});

test(
  'attemptLlmAssist: a picked candidate re-geocodes to real coordinates, flagged llm_assisted, and logs a succeeded row',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    }),
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      try {
        // "997 Peqwket Trl" (misspelled) should surface "Pequawket Trl" (id=12, zip 04091)
        // as the top candidate and re-geocode to its real coordinates.
        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.ok(result);
        assert.equal(result.source, 'llm_assisted');
        assert.equal(result.originalInput, '997 Peqwket Trl, 04091');
        assert.match(result.correctedAddress, /Pequawket Trl/);
        assert.ok(result.coordinates.latitude);
        assert.ok(result.coordinates.longitude);
        assert.equal(result.match.fullname, 'Pequawket Trl');

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, true);
        assert.equal(rows[0].email, 'demo@example.com');
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  'attemptLlmAssist: "none fit" returns null and logs a failed attempt with failure_reason none_fit',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'none', reason: 'nothing close enough' } }],
      }),
    }),
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      try {
        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.equal(result, null);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, false);
        assert.equal(rows[0].failure_reason, 'none_fit');
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  'attemptLlmAssist: an Anthropic API failure returns null and logs a failed attempt with failure_reason llm_error',
  withFakeFetch(
    () => {
      throw new Error('network down');
    },
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      try {
        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.equal(result, null);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, false);
        assert.equal(rows[0].failure_reason, 'llm_error');
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd geocoding-server && node --test test/llmAssist.test.js`
Expected: FAIL — `Cannot find module '../src/llmAssist'`

- [ ] **Step 3: Write `llmAssist.js`**

Create `geocoding-server/src/llmAssist.js`:

```js
const { isPlausiblyInCoverageArea } = require('./geocodeCoverage');
const { candidateStreetNames, matchByStreetAndZip } = require('./geocodeMatching');
const { isLlmAssistConfigured, pickCandidateWithLlm, describeCandidate } = require('./anthropicClient');
const { logLlmGeocodeAssist } = require('./llmGeocodeAssists');

/**
 * Tries to rescue a failed geocode() attempt via an LLM-assisted retry.
 * Returns a geocode()-shaped result (source: 'llm_assisted') on success,
 * or null if nothing could be done -- geocode() throws its normal
 * NotFoundError in that case, same as if this were never called.
 *
 * Checked in order, cheapest/most-likely-to-short-circuit first:
 * configured -> in coverage area -> has real candidates -> LLM call.
 * Only an attempt that reaches the LLM call is logged (see
 * llmGeocodeAssists.js) -- out-of-range, unconfigured, or
 * zero-candidate cases never reach the LLM at all, so there's nothing
 * about this feature's own activity to log for them.
 */
async function attemptLlmAssist(db, { usersDb, email }, parsed, originalInput, offsetFeet) {
  if (!isLlmAssistConfigured()) return null;

  const inCoverage = await isPlausiblyInCoverageArea(db, parsed);
  if (!inCoverage) return null;

  const candidates = await candidateStreetNames(db, parsed.streetName, {
    zip: parsed.zip,
    state: parsed.state,
  });
  if (candidates.length === 0) return null;

  const { picked, failureReason } = await pickCandidateWithLlm(originalInput, candidates);

  if (!picked) {
    await logLlmGeocodeAssist(usersDb, {
      email,
      originalInput,
      candidates,
      picked: null,
      succeeded: false,
      failureReason,
    });
    return null;
  }

  const zip = picked.zipl || picked.zipr;
  const result = await matchByStreetAndZip(db, parsed.number, picked.fullname, zip, parsed.state, offsetFeet);
  const correctedAddress = describeCandidate(picked);

  await logLlmGeocodeAssist(usersDb, {
    email,
    originalInput,
    candidates,
    picked: correctedAddress,
    succeeded: true,
    failureReason: null,
  });

  return {
    ...result,
    source: 'llm_assisted',
    originalInput,
    correctedAddress,
  };
}

module.exports = { attemptLlmAssist };
```

- [ ] **Step 4: Wire the retry into `geocode()`**

Replace the full contents of `geocoding-server/src/geocode.js` (built on top of Task 2's version) with:

```js
const { parseAddress } = require('./parseAddress');
const { NotFoundError } = require('./errors');
const { matchAddressPoint, matchByStreetAndZip } = require('./geocodeMatching');
const { attemptLlmAssist } = require('./llmAssist');

/**
 * Resolves a free-text address to coordinates using the local `streets`
 * table: odd house numbers interpolate against the left range
 * (lfromadd/ltoadd), match on zipl, and are offset left of the
 * centerline; even house numbers use the right range (rfromadd/rtoadd),
 * match on zipr, and are offset right.
 *
 * `llmAssist`, when provided as `{ usersDb, email }`, enables an LLM-
 * assisted retry (see llmAssist.js) on a NotFoundError -- never on an
 * OutOfRangeError, since that means the street already matched
 * correctly and only the house number didn't fit any segment, which a
 * street-name-similarity retry has nothing useful to offer for. Only
 * server.js's /geocode handler ever passes this, and only when the
 * request is authenticated -- every other caller (including
 * batchGeocode.js) always gets today's plain-404 behavior unchanged.
 */
async function geocode(db, addressInput, { offsetFeet = 20, llmAssist = null } = {}) {
  const parsed = parseAddress(addressInput);
  const { number, streetName, zip, state, town } = parsed;

  const addressPoint = await matchAddressPoint(db, number, streetName, town, zip, state);
  if (addressPoint) {
    return {
      input: { number, streetName, zip, state, town },
      match: {
        siteUid: addressPoint.site_uid,
        fullname: addressPoint.street_fullname,
        town: addressPoint.town,
        county: addressPoint.county,
        state_abbr: addressPoint.state_abbr,
      },
      source: 'address_point',
      coordinates: { latitude: addressPoint.latitude, longitude: addressPoint.longitude },
    };
  }

  // No exact address-point match, and no ZIP to fall back on -- unlike
  // matchAddressPoint (keyed by town), candidateStreets has no town/city
  // column to filter by at all (TIGER's street_names only carries
  // zipl/zipr/state), so a common street name has no other way to be
  // disambiguated here. Caught explicitly, with a message naming the
  // actual problem, rather than letting `street_names.zipColumn = NULL`
  // silently match nothing and surface as a confusing "in ZIP null".
  if (!zip) {
    const notFound = new NotFoundError(
      `could not find an exact address match for "${streetName}" in ${town ?? 'the given town'} -- ` +
        'add a ZIP code to search by street range instead'
    );
    if (llmAssist) {
      const assisted = await attemptLlmAssist(db, llmAssist, parsed, addressInput, offsetFeet);
      if (assisted) return { input: { number, streetName, zip, state, town }, ...assisted };
    }
    throw notFound;
  }

  try {
    const result = await matchByStreetAndZip(db, number, streetName, zip, state, offsetFeet);
    return { input: { number, streetName, zip, state, town }, ...result };
  } catch (err) {
    if (err instanceof NotFoundError && llmAssist) {
      const assisted = await attemptLlmAssist(db, llmAssist, parsed, addressInput, offsetFeet);
      if (assisted) return { input: { number, streetName, zip, state, town }, ...assisted };
    }
    throw err;
  }
}

module.exports = { geocode };
```

- [ ] **Step 5: Run the new orchestration tests to verify they pass**

Run: `cd geocoding-server && node --test test/llmAssist.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 6: Run the full geocode test suite again to confirm no regression**

Run: `cd geocoding-server && node --test test/geocode.test.js`
Expected: PASS, same count as Task 2 Step 7's baseline — `geocode()` with no `llmAssist` option (every existing test's call shape) must behave identically to before this task.

- [ ] **Step 7: Commit**

```bash
cd geocoding-server
git add src/llmAssist.js src/geocode.js test/llmAssist.test.js
git commit -m "Wire the LLM-assisted retry into geocode()'s failure path"
```

---

### Task 6: Server integration, end-to-end test, batch regression test

**Files:**
- Modify: `geocoding-server/src/server.js:217` (the `/geocode` handler's `geocode()` call)
- Test: `geocoding-server/test/geocodeLlmAssistEndpoint.test.js`

**Interfaces:**
- Consumes: `geocode()`'s new `llmAssist` option (Task 5).

- [ ] **Step 1: Write the failing tests**

Create `geocoding-server/test/geocodeLlmAssistEndpoint.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser } = require('../src/users');
const { geocodeAddressList } = require('../src/batchGeocode');
const { withTestServer, makeDb } = require('./helpers');

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

function withApiKey(fn) {
  return async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  };
}

test(
  'POST /geocode: an authenticated request with a misspelled street gets an LLM-assisted match',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    }),
    withApiKey(() =>
      withTestServer(async ({ port, usersDb }) => {
        const user = await upsertUser(usersDb, 'demo@example.com', 'starter');

        const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: '997 Peqwket Trl, 04091',
            email: 'demo@example.com',
            serviceKey: user.service_key,
          }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.source, 'llm_assisted');
        assert.equal(body.originalInput, '997 Peqwket Trl, 04091');
        assert.match(body.correctedAddress, /Pequawket Trl/);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists WHERE email = $1', ['demo@example.com']);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, true);
      })
    )
  )
);

test('POST /geocode: an unauthenticated request with the same misspelled street never calls the LLM and gets a plain 404', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called for an unauthenticated request');
  };
  try {
    await withApiKey(() =>
      withTestServer(async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: '997 Peqwket Trl, 04091' }),
        });
        assert.equal(response.status, 404);
      })
    )();
  } finally {
    global.fetch = savedFetch;
  }
});

test('POST /geocode: an authenticated request still gets today\'s plain 404 when ANTHROPIC_API_KEY is unset', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called when unconfigured');
  };
  try {
    await withTestServer(async ({ port, usersDb }) => {
      const user = await upsertUser(usersDb, 'demo2@example.com', 'starter');
      const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: '997 Peqwket Trl, 04091',
          email: 'demo2@example.com',
          serviceKey: user.service_key,
        }),
      });
      assert.equal(response.status, 404);
    })();
  } finally {
    global.fetch = savedFetch;
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('Batch geocoding never triggers the LLM, even with a deliberately misspelled, otherwise-assistable address', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called during a batch run');
  };
  try {
    await withApiKey(async () => {
      const db = await makeDb();
      try {
        const results = await geocodeAddressList(db, ['997 Peqwket Trl, 04091'], { offsetFeet: 20 });
        assert.equal(results.length, 1);
        assert.equal(results[0].success, false);
        assert.match(results[0].error, /no street found matching/);
      } finally {
        await db.close();
      }
    })();
  } finally {
    global.fetch = savedFetch;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd geocoding-server && node --test test/geocodeLlmAssistEndpoint.test.js`
Expected: FAIL — `/geocode` doesn't pass `llmAssist` yet, so the first test gets a 404 instead of a 200 with `source: "llm_assisted"`.

- [ ] **Step 3: Wire `llmAssist` into the `/geocode` handler**

Modify `geocoding-server/src/server.js:217` — the `/geocode` handler's call to `geocode()` (currently `const result = await geocode(db, address, { offsetFeet: OFFSET_FEET });`, the only call site inside `app.post('/geocode', ...)` to change — re-confirm the exact line with `grep -n "const result = await geocode(db, address" src/server.js` first, since earlier tasks in this plan don't touch `server.js` but other work may have landed on this branch since this plan was written):

```js
    const result = await geocode(db, address, {
      offsetFeet: OFFSET_FEET,
      llmAssist: authenticated ? { usersDb, email } : null,
    });
```

(`usersDb` and `email` are both already in scope at this point in the handler — `usersDb` is assigned a few lines above inside the `if (authenticated)` branch, `email` is the handler's own top-level `const`. No other change to this handler is needed; the existing `try`/`catch` error-mapping block already handles `NotFoundError` → 404 unchanged, since `attemptLlmAssist` returning `null` just lets the original `NotFoundError` propagate exactly as before.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd geocoding-server && node --test test/geocodeLlmAssistEndpoint.test.js`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Run the full server test suite**

Run: `cd geocoding-server && node --test`
Expected: PASS — every existing test (including every other `/geocode`/batch caller elsewhere in the suite) still passes, with the new test files' tests also included in the total count.

- [ ] **Step 6: Commit**

```bash
cd geocoding-server
git add src/server.js test/geocodeLlmAssistEndpoint.test.js
git commit -m "Enable LLM-assisted geocoding on the authenticated /geocode path"
```

---

## Final verification (after all six tasks)

- [ ] Run `cd geocoding-server && node --test` — full suite passes.
- [ ] Confirm the `ANTHROPIC_API_KEY` env var is documented in `CLAUDE.md`'s "Server env vars" section (optional, unset = feature silently disabled, same convention as `HERE_API_KEY`), the new `llm_geocode_assists` table is mentioned alongside the other `geocoding_users` tables, and the new `pg_trgm` one-time extension requirement is mentioned alongside PostGIS/pgRouting's own setup note.
- [ ] **Before this feature can work on any real database**, run manually, once, against the `geocoding` database on each box that needs it (local dev, `geocoding-test`, `geocoding-prod`):
  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  ```
  followed by re-running `geocoding/schema.py`'s `CREATE_STREET_NAMES_INDEXES_SQL` (e.g. via `ingest_featnames.py`'s own table-setup call, or a one-off `psql -f` of just that block) to add the new `idx_street_names_fullname_trgm` index. Without this, `candidateStreetNames`'s `similarity()` calls fail outright with "function similarity(text, text) does not exist" — confirm this works by running a real misspelled-address request against the local dev server before considering this feature deployed anywhere.
- [ ] Set `ANTHROPIC_API_KEY` in whichever environment(s) should actually have this feature live (a real decision for the user to make per-environment, same as how `RESEND_API_KEY` was deliberately added to `geocoding-test` only before later being added to prod, not both at once by default).
- [ ] With the extension/index and env var both in place on a real target environment, `curl` a deliberately misspelled authenticated `/geocode` request and confirm a real `source: "llm_assisted"` response comes back with genuinely correct coordinates, then `psql` into `geocoding_users` and confirm a row landed in `llm_geocode_assists`.
