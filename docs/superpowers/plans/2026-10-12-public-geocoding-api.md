# Public Geocoding API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let outside developers call Meridian's geocoding endpoints directly (instead of only through the batch-file-upload UI), by adding optional metered auth + a persistent per-IP rate limiter to the two currently-wide-open single-lookup endpoints, and publishing a real `/api-docs` page.

**Architecture:** `POST /geocode` and `POST /reverse-geocode` gain optional `email`+`serviceKey` body fields — present and valid, the request draws from that account's existing paid quota (same `checkQuota`/`useQuota` path `/geocode/batch` already uses); absent, the request stays free but is checked against a new per-IP-per-day Postgres table that blocks an IP for the rest of the UTC day once it exceeds 10 requests in a ~60-second window. `/geocode/batch*` are untouched. A new `/api-docs` page on `ui/desktop` documents all five endpoints with real `curl` examples.

**Tech Stack:** Node.js/Express (`geocoding-server`), `pg` (node-postgres) against the existing `geocoding_users` database, React/TypeScript (`ui/desktop`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-public-geocoding-api-design.md`

## Global Constraints

- Auth stays `email`+`serviceKey` as JSON body fields everywhere — no `Authorization` header, no new auth mechanism (spec's explicit out-of-scope).
- Zero changes to `ui/desktop`'s `Geocode.tsx`/`ReverseGeocode.tsx` or `ui/mobile`'s `GeocodeForm.tsx`/`ReverseGeocodeForm.tsx` — all four already send no credentials, which is exactly the free/rate-limited path.
- Rate-limit state lives in `geocoding_users` (not the read-only `geocoding` database), following `transactions`/`road_alerts_push_subscriptions`'s existing precedent.
- Every new DB-touching module follows this repo's `ensureXTable(pool)` idempotent-create convention (see `transactions.js`, `roadAlertsPush.js`).
- Commits are small and single-purpose, imperative present tense, no trailing period (see `CLAUDE.md`).
- Run `cd geocoding-server && node --test` after touching any server file; run `cd ui/desktop && npx tsc -b && npm test` after touching any frontend file.

---

## Task 1: Rate-limit module, error type, and owner notification

**Files:**
- Create: `geocoding-server/src/geocodeRateLimit.js`
- Create: `geocoding-server/test/geocodeRateLimit.test.js`
- Create: `geocoding-server/scripts/cleanup-geocode-rate-limits.js`
- Modify: `geocoding-server/src/errors.js`
- Modify: `geocoding-server/src/emailDelivery.js`
- Modify: `geocoding-server/test/emailDelivery.test.js`

**Interfaces:**
- Produces: `ensureGeocodeRateLimitsTable(pool): Promise<void>`, `checkRateLimit(pool, ipAddress): Promise<void>` (throws `RateLimitError` when blocked), `deleteOldRateLimits(pool, days): Promise<number>` — all exported from `geocodeRateLimit.js`.
- Produces: `RateLimitError` class, exported from `errors.js` alongside the existing error classes.
- Produces: `sendRateLimitBlockedNotification({ ipAddress, totalCount }): Promise<{delivered, stubbed, error?}>`, exported from `emailDelivery.js`.
- Consumes: `isEmailConfigured()`, `sendPlainTextEmail({ to, subject, text })` (both already private/exported in `emailDelivery.js`).

This task is fully self-contained — nothing here is wired into a live HTTP endpoint yet (that's Task 2), so it's testable entirely against a throwaway test database.

- [ ] **Step 1: Add `RateLimitError` to `errors.js`**

```js
// geocoding-server/src/errors.js
class ValidationError extends Error {}
class NotFoundError extends Error {}
class OutOfRangeError extends Error {}
class QuotaExceededError extends Error {}
class PaymentError extends Error {}
class UnauthorizedError extends Error {}
class UpstreamError extends Error {}
// An unauthenticated caller has exceeded the per-IP rate limit on
// /geocode or /reverse-geocode (see geocodeRateLimit.js). Maps to HTTP
// 429, same status QuotaExceededError already uses for the analogous
// authenticated-but-over-quota case.
class RateLimitError extends Error {}

module.exports = {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
  PaymentError,
  UnauthorizedError,
  UpstreamError,
  RateLimitError,
};
```

- [ ] **Step 2: Write the failing test for `sendRateLimitBlockedNotification`**

First, change the existing import at the top of `geocoding-server/test/emailDelivery.test.js` to add `sendRateLimitBlockedNotification`:

```js
const {
  sendServiceKeyEmail,
  sendRoadAlertEmail,
  sendFeedbackNotification,
  sendTransactionsDigestEmail,
  sendBatchRunNotification,
  sendRateLimitBlockedNotification,
} = require('../src/emailDelivery');
```

Then add these two tests to the same file, right after the existing `sendBatchRunNotification` tests (reusing the file's existing `withResendConfigured` helper already defined at the top):

```js
test(
  'sendRateLimitBlockedNotification sends to TRANSACTIONS_NOTIFY_EMAIL when configured',
  withResendConfigured({ TRANSACTIONS_NOTIFY_EMAIL: 'owner@example.com' }, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    const result = await sendRateLimitBlockedNotification({ ipAddress: '203.0.113.5', totalCount: 11 });

    assert.deepEqual(result, { delivered: true, stubbed: false });
    assert.equal(fetchMock.mock.callCount(), 1);

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, ['owner@example.com']);
    assert.match(body.text, /203\.0\.113\.5/);
    assert.match(body.text, /11/);
    assert.match(body.subject, /203\.0\.113\.5/);
  })
);

test(
  'sendRateLimitBlockedNotification falls back to the stub when TRANSACTIONS_NOTIFY_EMAIL is missing',
  withResendConfigured({}, async (t) => {
    const savedNotifyEmail = process.env.TRANSACTIONS_NOTIFY_EMAIL;
    delete process.env.TRANSACTIONS_NOTIFY_EMAIL;
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    try {
      const result = await sendRateLimitBlockedNotification({ ipAddress: '203.0.113.5', totalCount: 11 });
      assert.deepEqual(result, { delivered: false, stubbed: true });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      if (savedNotifyEmail !== undefined) process.env.TRANSACTIONS_NOTIFY_EMAIL = savedNotifyEmail;
    }
  })
);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd geocoding-server && node --test test/emailDelivery.test.js`
Expected: FAIL — `sendRateLimitBlockedNotification is not a function`

- [ ] **Step 4: Implement `sendRateLimitBlockedNotification` in `emailDelivery.js`**

Add right after the existing `sendBatchRunNotification` function, before `module.exports`:

```js
// geocoding-server/src/emailDelivery.js
/**
 * Notifies the owner (TRANSACTIONS_NOTIFY_EMAIL, same recipient as every
 * other notification in this file) the moment an IP gets blocked by the
 * unauthenticated /geocode or /reverse-geocode rate limiter (see
 * geocodeRateLimit.js) -- fired exactly once per IP per day, right when
 * blocked_at is first set, never again for that IP's later-rejected
 * requests that same day. Best-effort, same stub-when-unconfigured
 * convention as every other send here.
 */
async function sendRateLimitBlockedNotification({ ipAddress, totalCount }) {
  const text =
    `IP ${ipAddress} was blocked from unauthenticated /geocode and /reverse-geocode ` +
    `requests for the rest of today, after ${totalCount.toLocaleString()} request${totalCount === 1 ? '' : 's'} ` +
    `(limit: 10/minute, unauthenticated).\n`;

  if (!isEmailConfigured() || !process.env.TRANSACTIONS_NOTIFY_EMAIL) {
    console.log('[emailDelivery stub] would notify owner of a rate-limit block', { ipAddress, totalCount });
    return { delivered: false, stubbed: true };
  }

  return sendPlainTextEmail({
    to: process.env.TRANSACTIONS_NOTIFY_EMAIL,
    subject: `Rate limit block: ${ipAddress}`,
    text,
  });
}
```

Add `sendRateLimitBlockedNotification` to the `module.exports` object at the bottom of the file, alongside the existing exports.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd geocoding-server && node --test test/emailDelivery.test.js`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 6: Commit**

```bash
cd geocoding-server
git add src/errors.js src/emailDelivery.js test/emailDelivery.test.js
git commit -m "Add RateLimitError and the owner rate-limit-block notification"
```

- [ ] **Step 7: Write the failing tests for `geocodeRateLimit.js`**

Create `geocoding-server/test/geocodeRateLimit.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeUsersDb } = require('./helpers');
const {
  ensureGeocodeRateLimitsTable,
  checkRateLimit,
  deleteOldRateLimits,
} = require('../src/geocodeRateLimit');
const { RateLimitError } = require('../src/errors');

// makeUsersDb() (unlike withTestServer, see helpers.js) does NOT clear
// RESEND_API_KEY/RESEND_FROM_EMAIL -- checkRateLimit can call
// sendRateLimitBlockedNotification internally once an IP is blocked, so
// without this, a test here could attempt a real Resend network call if
// the developer's own .env happens to have those set. Exact same
// problem, exact same fix as transactionsDigest.test.js's own
// withStubbedEmail helper.
function withStubbedEmail(fn) {
  const saved = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  };
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });
}

test('checkRateLimit allows a fresh IP under the threshold', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(db, '203.0.113.1'); // does not throw
    }

    const { rows } = await db.query(
      'SELECT window_count, total_count, blocked_at FROM geocode_rate_limits WHERE ip_address = $1',
      ['203.0.113.1']
    );
    assert.equal(rows[0].window_count, 10);
    assert.equal(rows[0].total_count, 10);
    assert.equal(rows[0].blocked_at, null);

    await db.close();
  }));

test('checkRateLimit blocks on the 11th request within a minute and notifies the owner', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(db, '203.0.113.2');
    }

    await assert.rejects(() => checkRateLimit(db, '203.0.113.2'), RateLimitError);

    const { rows } = await db.query('SELECT blocked_at, total_count FROM geocode_rate_limits WHERE ip_address = $1', [
      '203.0.113.2',
    ]);
    assert.ok(rows[0].blocked_at);
    assert.equal(rows[0].total_count, 11);

    await db.close();
  }));

test('checkRateLimit keeps rejecting every further request that same day, and keeps counting them', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 11; i++) {
      await checkRateLimit(db, '203.0.113.3').catch(() => {});
    }

    await assert.rejects(() => checkRateLimit(db, '203.0.113.3'), RateLimitError);
    await assert.rejects(() => checkRateLimit(db, '203.0.113.3'), RateLimitError);

    // The upsert always runs before the blocked_at check (see
    // checkRateLimit's own comment) -- total_count keeps accumulating for
    // a persistent abuser even after blocking, which is a deliberate
    // choice: it tells the owner how severe the abuse actually was, and a
    // single always-atomic upsert (no separate "is this IP already
    // blocked" read first) means no race window between that read and the
    // write. 11 initial + 2 more rejected = 13.
    const { rows } = await db.query('SELECT total_count, blocked_at FROM geocode_rate_limits WHERE ip_address = $1', [
      '203.0.113.3',
    ]);
    assert.equal(rows[0].total_count, 13);
    assert.ok(rows[0].blocked_at);

    await db.close();
  }));

test('checkRateLimit resets the window after 60 seconds, not the day-long block', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(db, '203.0.113.4');
    }
    // Simulate the window having started over a minute ago, same pattern
    // roadAlertsPushWorker.test.js uses for its own staleness tests.
    await db.query(
      `UPDATE geocode_rate_limits SET window_started_at = now() - interval '2 minutes' WHERE ip_address = $1`,
      ['203.0.113.4']
    );

    await checkRateLimit(db, '203.0.113.4'); // does not throw -- window rolled over

    const { rows } = await db.query('SELECT window_count, total_count FROM geocode_rate_limits WHERE ip_address = $1', [
      '203.0.113.4',
    ]);
    assert.equal(rows[0].window_count, 1); // reset, not 11
    assert.equal(rows[0].total_count, 11); // total keeps accumulating regardless

    await db.close();
  }));

test('deleteOldRateLimits only deletes rows older than the given number of days', () =>
  withStubbedEmail(async () => {
    const db = await makeUsersDb();
    await ensureGeocodeRateLimitsTable(db);

    await checkRateLimit(db, '203.0.113.6'); // today
    await db.query(
      `INSERT INTO geocode_rate_limits (ip_address, date, window_started_at, window_count, total_count)
       VALUES ('203.0.113.7', CURRENT_DATE - 100, now() - interval '100 days', 1, 1)`
    );

    const deletedCount = await deleteOldRateLimits(db, 90);
    assert.equal(deletedCount, 1);

    const { rows } = await db.query('SELECT ip_address FROM geocode_rate_limits ORDER BY ip_address');
    assert.deepEqual(rows.map((r) => r.ip_address), ['203.0.113.6']);

    await db.close();
  }));
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `cd geocoding-server && node --test test/geocodeRateLimit.test.js`
Expected: FAIL — `Cannot find module '../src/geocodeRateLimit'`

- [ ] **Step 9: Implement `geocodeRateLimit.js`**

```js
// geocoding-server/src/geocodeRateLimit.js
const { RateLimitError } = require('./errors');
const { sendRateLimitBlockedNotification } = require('./emailDelivery');

const CREATE_RATE_LIMITS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS geocode_rate_limits (
  ip_address TEXT NOT NULL,
  date DATE NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  blocked_at TIMESTAMPTZ,
  PRIMARY KEY (ip_address, date)
);
`;

async function ensureGeocodeRateLimitsTable(pool) {
  await pool.query(CREATE_RATE_LIMITS_TABLE_SQL);
}

const WINDOW_LIMIT = 10;

/**
 * Throws RateLimitError if `ipAddress` has exceeded 10 unauthenticated
 * /geocode or /reverse-geocode requests within a ~60-second window today
 * (UTC) -- blocking it from further unauthenticated requests for the
 * rest of the UTC day, not just until the window rolls over. See
 * docs/superpowers/specs/2026-10-12-public-geocoding-api-design.md.
 *
 * The single INSERT ... ON CONFLICT DO UPDATE atomically handles "new IP
 * today" and "existing IP, roll or extend the window" in one round trip
 * -- no separate read-then-write race between concurrent requests from
 * the same IP. An already-blocked IP still runs through this upsert
 * (cheap, one indexed row) before the blocked_at check short-circuits,
 * so window_count/window_started_at can keep moving in the background
 * for a blocked IP, but that's harmless -- blocked_at being set is
 * checked first and is what actually governs the response.
 */
async function checkRateLimit(pool, ipAddress) {
  const { rows } = await pool.query(
    `INSERT INTO geocode_rate_limits (ip_address, date, window_started_at, window_count, total_count)
     VALUES ($1, CURRENT_DATE, now(), 1, 1)
     ON CONFLICT (ip_address, date) DO UPDATE SET
       window_count = CASE
         WHEN geocode_rate_limits.window_started_at <= now() - interval '1 minute' THEN 1
         ELSE geocode_rate_limits.window_count + 1
       END,
       window_started_at = CASE
         WHEN geocode_rate_limits.window_started_at <= now() - interval '1 minute' THEN now()
         ELSE geocode_rate_limits.window_started_at
       END,
       total_count = geocode_rate_limits.total_count + 1
     RETURNING *`,
    [ipAddress]
  );
  const row = rows[0];

  const message =
    'Rate limit exceeded: unauthenticated requests are limited to 10/minute. ' +
    "You're blocked from further anonymous requests for the rest of today -- " +
    'sign up for a free account to get a service key for uninterrupted access.';

  if (row.blocked_at) {
    throw new RateLimitError(message);
  }

  if (row.window_count > WINDOW_LIMIT) {
    await pool.query(`UPDATE geocode_rate_limits SET blocked_at = now() WHERE ip_address = $1 AND date = $2`, [
      ipAddress,
      row.date,
    ]);
    await sendRateLimitBlockedNotification({ ipAddress, totalCount: row.total_count });
    throw new RateLimitError(message);
  }
}

/** Same `>N days` pattern as feedback.js's deleteOldFeedback, dated off `date` (not created_at -- this table has no created_at column). */
async function deleteOldRateLimits(pool, days) {
  const { rowCount } = await pool.query('DELETE FROM geocode_rate_limits WHERE date < CURRENT_DATE - $1::integer', [
    days,
  ]);
  return rowCount;
}

module.exports = { ensureGeocodeRateLimitsTable, checkRateLimit, deleteOldRateLimits };
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd geocoding-server && node --test test/geocodeRateLimit.test.js`
Expected: PASS, all 5 tests.

- [ ] **Step 11: Create the pruning script**

```js
#!/usr/bin/env node
// Deletes geocode_rate_limits rows older than N days, so the table
// doesn't accumulate forever. Meant to run periodically -- see
// ops/ for a systemd timer/service pair or crontab alternative,
// mirroring scripts/cleanup-feedback.js exactly.
//
//   node scripts/cleanup-geocode-rate-limits.js [days]   (default: 90)

require('dotenv').config();

const { Pool } = require('../src/db');
const { ensureGeocodeRateLimitsTable, deleteOldRateLimits } = require('../src/geocodeRateLimit');

const USERS_DSN =
  process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';

async function main() {
  const days = Number(process.argv[2]) || 90;
  const pool = new Pool({ connectionString: USERS_DSN });
  try {
    await ensureGeocodeRateLimitsTable(pool);
    const deleted = await deleteOldRateLimits(pool, days);
    console.log(`Deleted ${deleted} geocode_rate_limits row(s) older than ${days} days`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

Save as `geocoding-server/scripts/cleanup-geocode-rate-limits.js`.

- [ ] **Step 12: Run the full server test suite**

Run: `cd geocoding-server && node --test`
Expected: PASS — every existing test still passes, plus the new ones from this task.

- [ ] **Step 13: Commit**

```bash
cd geocoding-server
git add src/geocodeRateLimit.js test/geocodeRateLimit.test.js scripts/cleanup-geocode-rate-limits.js
git commit -m "Add the geocode_rate_limits table, checkRateLimit, and its cleanup script"
```

---

## Task 2: Wire optional auth + rate limiting into `/geocode` and `/reverse-geocode`

**Files:**
- Modify: `geocoding-server/src/server.js:71` (new require), `:83-90` (errors require), `:163` (usersDbPromise chain), `:167` (trust proxy), `:183-194` (`/geocode` handler), `:576-585` (`/reverse-geocode` handler)
- Create: `geocoding-server/test/geocodeAuthRateLimit.test.js`

**Interfaces:**
- Consumes (from Task 1): `ensureGeocodeRateLimitsTable`, `checkRateLimit` from `./geocodeRateLimit`; `RateLimitError` from `./errors`.
- Consumes (already in `server.js`): `checkQuota`, `useQuota` from `./quota`; `usersDbPromise`.

- [ ] **Step 1: Write the failing endpoint tests**

Create `geocoding-server/test/geocodeAuthRateLimit.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser } = require('../src/users');
const { withTestServer } = require('./helpers');

// 997 Pequawket Trl, Standish, ME 04091 is the standard seeded fixture
// address used throughout this test suite (see geocode.test.js) --
// resolves to match.id 12 against the default makeFixtureDsn() seed.
const FIXTURE_ADDRESS = '997 Pequawket Trl, Standish, ME 04091';

test('POST /geocode with no credentials succeeds for the first 10 requests from one IP', () =>
  withTestServer(async ({ port }) => {
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS }),
      });
      assert.equal(response.status, 200, `request ${i + 1} should succeed`);
    }
  }));

test('POST /geocode with no credentials returns 429 on the 11th request in under a minute', () =>
  withTestServer(async ({ port }) => {
    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS }),
      });
    }
    const eleventh = await fetch(`http://127.0.0.1:${port}/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: FIXTURE_ADDRESS }),
    });
    assert.equal(eleventh.status, 429);
    const body = await eleventh.json();
    assert.match(body.error, /Rate limit exceeded/);
  }));

test('POST /geocode with valid credentials draws from quota and is never rate-limited', () =>
  withTestServer(async ({ port, usersDb }) => {
    const user = await upsertUser(usersDb, 'alice@example.com', 1000);

    for (let i = 0; i < 15; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS, email: 'alice@example.com', serviceKey: user.service_key }),
      });
      assert.equal(response.status, 200, `authenticated request ${i + 1} should succeed past the 10/min anonymous limit`);
    }

    const { rows } = await usersDb.query('SELECT used_this_period FROM users WHERE email = $1', ['alice@example.com']);
    assert.equal(rows[0].used_this_period, 15);
  }));

test('POST /geocode with an invalid service key returns 401, not a silent fall-back to the free path', () =>
  withTestServer(async ({ port, usersDb }) => {
    await upsertUser(usersDb, 'alice@example.com', 1000);

    const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: FIXTURE_ADDRESS, email: 'alice@example.com', serviceKey: 'wrong-key' }),
    });
    assert.equal(response.status, 401);
  }));

test('POST /reverse-geocode with no credentials is rate-limited the same way as /geocode, sharing the same IP bucket', () =>
  withTestServer(async ({ port }) => {
    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: FIXTURE_ADDRESS }),
      });
    }
    // The 11th unauthenticated request, even to the *other* endpoint,
    // should already be blocked -- same IP, same day, same bucket.
    const response = await fetch(`http://127.0.0.1:${port}/reverse-geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 43.9, longitude: -70.9 }),
    });
    assert.equal(response.status, 429);
  }));

test('POST /reverse-geocode with valid credentials draws from quota', () =>
  withTestServer(async ({ port, usersDb }) => {
    const user = await upsertUser(usersDb, 'alice@example.com', 1000);

    const response = await fetch(`http://127.0.0.1:${port}/reverse-geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 43.9, longitude: -70.9, email: 'alice@example.com', serviceKey: user.service_key }),
    });
    assert.equal(response.status, 200);

    const { rows } = await usersDb.query('SELECT used_this_period FROM users WHERE email = $1', ['alice@example.com']);
    assert.equal(rows[0].used_this_period, 1);
  }));

test('req.ip resolves the real client IP from X-Forwarded-For, not the proxy', () =>
  withTestServer(async ({ port }) => {
    // Two different claimed client IPs, each sent 10 requests -- if
    // trust proxy weren't configured, both would land in the same
    // bucket (the test runner's own loopback address) and the second
    // IP's 10th request would already be blocked by the first IP's
    // prior traffic. It isn't, which proves they're tracked separately.
    for (const ip of ['203.0.113.10', '203.0.113.11']) {
      for (let i = 0; i < 10; i++) {
        const response = await fetch(`http://127.0.0.1:${port}/geocode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify({ address: FIXTURE_ADDRESS }),
        });
        assert.equal(response.status, 200, `${ip} request ${i + 1} should succeed`);
      }
    }
  }));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd geocoding-server && node --test test/geocodeAuthRateLimit.test.js`
Expected: FAIL — the 11th-request/429 tests fail because every request currently succeeds (no rate limiting yet); the invalid-service-key test fails because `/geocode` doesn't check credentials at all yet.

- [ ] **Step 3: Add `trust proxy` and the Task 1 requires to `server.js`**

At `geocoding-server/src/server.js:71`, insert a new line right after the existing `checkQuota`/`useQuota` require:

```js
const { checkQuota, useQuota } = require('./quota');
const { ensureGeocodeRateLimitsTable, checkRateLimit } = require('./geocodeRateLimit');
```

At `geocoding-server/src/server.js:83-90`, add `RateLimitError` to the existing destructured `require('./errors')` block:

```js
const {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
  PaymentError,
  UnauthorizedError,
  UpstreamError,
  RateLimitError,
} = require('./errors');
```

At `geocoding-server/src/server.js:167`, add `app.set('trust proxy', 'loopback')` immediately after `const app = express();`:

```js
const app = express();
// nginx (see ops/ and the deployed droplets' /etc/nginx/sites-enabled
// configs) already sets X-Real-IP/X-Forwarded-For correctly and always
// connects from the same box -- 'loopback' trusts exactly that one hop,
// so req.ip resolves to the real client IP instead of nginx's own
// address. Required for geocodeRateLimit.js's per-IP tracking to work
// at all; without it, every caller behind the proxy would share one
// bucket.
app.set('trust proxy', 'loopback');
```

At `geocoding-server/src/server.js:163`, add one line to the `usersDbPromise` chain, right before its `return pool;`:

```js
const usersDbPromise = openUsersDb(USERS_DSN).then(async (pool) => {
  await ensureFeedbackTable(pool);
  await ensureTransactionsTable(pool);
  await ensureRoadAlertsAccountsTable(pool);
  await ensureRoadAlertsSurfacedLogTable(pool);
  await ensureRoadAlertsTopicsTable(pool);
  await ensureRoadAlertsStatementsTable(pool);
  await ensureTestWeightedPointsTable(pool);
  await ensureWeightedPointsTable(pool);
  await ensureTestRoadSignalsTable(pool);
  await ensureRoadAlertsPushTables(pool);
  await ensureGeocodeRateLimitsTable(pool);
  return pool;
});
```

- [ ] **Step 4: Rewrite the `POST /geocode` handler**

Replace the existing handler at `geocoding-server/src/server.js:183-194`:

```js
app.post('/geocode', async (req, res) => {
  const address = req.body && req.body.address;
  const email = req.body && req.body.email;
  const serviceKey = req.body && req.body.serviceKey;
  const authenticated = typeof email === 'string' && email.trim().length > 0;
  try {
    const usersDb = await usersDbPromise;
    if (authenticated) {
      await checkQuota(usersDb, email, serviceKey, 1);
    } else {
      await checkRateLimit(usersDb, req.ip);
    }

    const result = await geocode(db, address, { offsetFeet: OFFSET_FEET });

    if (authenticated) {
      await useQuota(usersDb, email, 1);
    }
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
    if (err instanceof RateLimitError) return res.status(429).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});
```

- [ ] **Step 5: Rewrite the `POST /reverse-geocode` handler**

Replace the existing handler at `geocoding-server/src/server.js:576-585`:

```js
app.post('/reverse-geocode', async (req, res) => {
  const { latitude, longitude } = req.body || {};
  const email = req.body && req.body.email;
  const serviceKey = req.body && req.body.serviceKey;
  const authenticated = typeof email === 'string' && email.trim().length > 0;
  try {
    const usersDb = await usersDbPromise;
    if (authenticated) {
      await checkQuota(usersDb, email, serviceKey, 1);
    } else {
      await checkRateLimit(usersDb, req.ip);
    }

    const result = await reverseGeocode(db, latitude, longitude);

    if (authenticated) {
      await useQuota(usersDb, email, 1);
    }
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
    if (err instanceof RateLimitError) return res.status(429).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd geocoding-server && node --test test/geocodeAuthRateLimit.test.js`
Expected: PASS, all 7 tests.

- [ ] **Step 7: Run the full server test suite**

Run: `cd geocoding-server && node --test`
Expected: PASS — every existing test (including every other `/geocode`/`/reverse-geocode` caller elsewhere in the suite, if any) still passes.

- [ ] **Step 8: Commit**

```bash
cd geocoding-server
git add src/server.js test/geocodeAuthRateLimit.test.js
git commit -m "Add optional auth and a per-IP rate limit to /geocode and /reverse-geocode"
```

---

## Task 3: Public `/api-docs` page

**Files:**
- Create: `ui/desktop/src/pages/ApiDocs.tsx`
- Modify: `ui/desktop/src/App.tsx`
- Modify: `ui/desktop/src/components/AccountTabs.tsx`
- Modify: `ui/desktop/src/components/Layout.tsx`
- Modify: `ui/desktop/src/pages/SiteMap.tsx`
- Modify: `ui/desktop/src/App.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1/2 directly (this is a static documentation page describing their behavior) — but should only be implemented/merged after Task 2 is live, so the documented behavior is accurate and testable against a running server.
- Produces: a new `/api-docs` route, reachable from the nav.

This task has no new backend dependency and follows `Help.tsx`'s exact page conventions (`PageHeader`, `.plate` callout boxes, `.text-muted`, `<code>` blocks) — this app's closest existing analog, which also has no dedicated test file of its own (confirmed: only `App.test.tsx`'s nav-rendering test and `ImportAddresses.test.tsx` exist in this app's test suite), so this task adds one assertion to `App.test.tsx` rather than inventing new test infrastructure a sibling page doesn't have either.

- [ ] **Step 1: Write the failing test**

Add to `ui/desktop/src/App.test.tsx`:

```tsx
// ui/desktop/src/App.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import App from './App';

describe('App', () => {
  it('renders the nav and defaults to the Overview route', () => {
    render(<App />);
    expect(screen.getByRole('link', { name: 'Geocode' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Real addresses, not just estimates' })).toBeInTheDocument();
  });

  it('renders the API docs link in the footer, linking to /api-docs', () => {
    render(<App />);
    expect(screen.getByRole('link', { name: 'API Docs' })).toHaveAttribute('href', '#/api-docs');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui/desktop && npm test -- --run`
Expected: FAIL — no element with the role/name `API Docs` exists yet.

- [ ] **Step 3: Write the `ApiDocs.tsx` page**

```tsx
// ui/desktop/src/pages/ApiDocs.tsx
import AccountTabs from '../components/AccountTabs';
import PageHeader from '../components/PageHeader';

export default function ApiDocs() {
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader icon="help">API Docs</PageHeader>
      <AccountTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Call Meridian directly from your own code instead of uploading a file through this site --
        every endpoint below is the exact same one this site's own pages use.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        <strong>💡 Base URL:</strong> <code>https://api.meridiangeocoding.com</code> — every example
        below is a complete, runnable <code>curl</code> command against that URL.
      </div>

      <h2 style={{ marginTop: 0 }}>Authentication</h2>
      <p>
        Every endpoint accepts <code>email</code> and <code>serviceKey</code> as plain fields in the
        JSON request body — not an <code>Authorization</code> header. Get a service key from{' '}
        <a href="#/pricing">Pricing</a>; it's emailed to you right after purchase and never expires.
      </p>
      <p>
        <code>/geocode</code> and <code>/reverse-geocode</code> work <strong>without</strong> an
        account too — see Rate limits below for what that means. <code>/geocode/batch</code> and its
        two variants always require a real <code>email</code>+<code>serviceKey</code>.
      </p>

      <h2>Single lookups</h2>

      <h3>POST /geocode</h3>
      <p>Converts a street address to coordinates.</p>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode \\
  -H "Content-Type: application/json" \\
  -d '{"address": "4 Pleasant St, 04011"}'`}</code>
      </pre>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`{
  "input": { "number": 4, "streetName": "Pleasant St", "zip": "04011", "state": null, "town": null },
  "match": { "id": 23556, "tlid": "78007569", "fullname": "Pleasant St", "zipl": "04011", "zipr": "04011" },
  "source": "interpolation",
  "rangeSide": "right",
  "offsetSide": "right",
  "offsetFeet": 20,
  "coordinates": { "latitude": 43.91447417000781, "longitude": -69.9652059563305 }
}`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        <code>rangeSide</code> is which side of the street's stored address range the house number
        fell on (odd numbers → left, even → right — see <a href="#/help">Help</a> for why);{' '}
        <code>offsetSide</code>/<code>offsetFeet</code> describe how far the returned coordinate was
        nudged off the street centerline so it lands on the building's side of the road, not in the
        middle of the street.
      </p>
      <p>
        Add <code>email</code>/<code>serviceKey</code> to the body to draw from your account's quota
        instead of the free/rate-limited path:
      </p>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode \\
  -H "Content-Type: application/json" \\
  -d '{
    "address": "4 Pleasant St, 04011",
    "email": "you@example.com",
    "serviceKey": "mk_..."
  }'`}</code>
      </pre>

      <h3>POST /reverse-geocode</h3>
      <p>Converts coordinates to the nearest address — the reverse of the above.</p>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/reverse-geocode \\
  -H "Content-Type: application/json" \\
  -d '{"latitude": 43.91447417000781, "longitude": -69.9652059563305}'`}</code>
      </pre>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`{
  "input": { "latitude": 43.91447417000781, "longitude": -69.9652059563305 },
  "match": { "id": 23556, "tlid": "78007569", "fullname": "Pleasant St", "zipl": "04011", "zipr": "04011", "state": "Maine", "state_abbr": "ME" },
  "side": "right",
  "number": 4,
  "address": "4 Pleasant St",
  "distanceMeters": 6.096000483129015,
  "matchedCoordinates": { "latitude": 43.914526400362874, "longitude": -69.96522879840107 }
}`}</code>
      </pre>
      <p>
        Same optional <code>email</code>/<code>serviceKey</code> fields as <code>/geocode</code>, same
        effect: authenticated calls draw from your quota and are never rate-limited.
      </p>

      <h2>Rate limits (unauthenticated calls only)</h2>
      <p>
        Calling <code>/geocode</code> or <code>/reverse-geocode</code> with no credentials is free, but
        limited to <strong>10 requests per minute per IP address</strong>. Exceed that and you'll get:
      </p>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`HTTP/1.1 429 Too Many Requests
{
  "error": "Rate limit exceeded: unauthenticated requests are limited to 10/minute. You're blocked from further anonymous requests for the rest of today -- sign up for a free account to get a service key for uninterrupted access."
}`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        That block lasts for the rest of the current day (UTC), not just a minute — it's meant to stop
        the free single-lookup endpoint from being used as an unpaid substitute for{' '}
        <code>/geocode/batch</code>, not to rate-limit a person occasionally trying a few addresses.
        Pass <code>email</code>/<code>serviceKey</code> to skip this entirely.
      </p>

      <h2>Batch</h2>
      <p>
        All three batch endpoints require <code>email</code>+<code>serviceKey</code> and draw from
        your account's monthly quota (see <a href="#/plan-quota">Plan &amp; quota</a>). One address per
        line in <code>fileContent</code>, no cap on count.
      </p>

      <h3>POST /geocode/batch</h3>
      <p>Returns results as JSON, directly in the response.</p>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode/batch \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "you@example.com",
    "serviceKey": "mk_...",
    "fileContent": "4 Pleasant St, 04011\\n91 Chestnut St, Portland, ME 04101"
  }'`}</code>
      </pre>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`{
  "results": [
    { "address": "4 Pleasant St, 04011", "success": true, "coordinates": { "latitude": 43.914474, "longitude": -69.965206 }, ... },
    { "address": "91 Chestnut St, Portland, ME 04101", "success": true, "coordinates": { "latitude": 43.660743, "longitude": -70.260148 }, ... }
  ],
  "usedThisPeriod": 2,
  "remaining": 998,
  "tier": 1000
}`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        One bad address doesn't fail the whole batch — a failed row gets{' '}
        <code>{`{ "success": false, "error": "..." }`}</code> in its place instead of a coordinate.
      </p>

      <h3>POST /geocode/batch/download</h3>
      <p>
        Same request shape as above, but the response is a ZIP file (<code>results.csv</code> +{' '}
        <code>errors.csv</code>) instead of JSON:
      </p>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode/batch/download \\
  -H "Content-Type: application/json" \\
  -d '{"email": "you@example.com", "serviceKey": "mk_...", "fileContent": "4 Pleasant St, 04011"}' \\
  -o results.zip`}</code>
      </pre>

      <h3>POST /geocode/batch/email</h3>
      <p>Same again, but the ZIP is emailed to your account's own address instead of returned directly.</p>
      <pre style={{ background: 'var(--color-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode/batch/email \\
  -H "Content-Type: application/json" \\
  -d '{"email": "you@example.com", "serviceKey": "mk_...", "fileContent": "4 Pleasant St, 04011"}'`}</code>
      </pre>

      <h2>Errors</h2>
      <p>Every endpoint returns a plain <code>{`{ "error": "..." }`}</code> body with one of these HTTP statuses:</p>
      <ul>
        <li><code>400</code> — malformed request (bad address format, missing field)</li>
        <li><code>401</code> — <code>serviceKey</code> present but wrong/doesn't match <code>email</code></li>
        <li><code>404</code> — no match found for the address/coordinates, or an unknown account email</li>
        <li><code>422</code> — coordinates or address out of the supported range</li>
        <li><code>429</code> — rate-limited (see above) or your account's quota is exhausted this period</li>
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Wire the route in `App.tsx`**

Add the import alongside the other page imports:

```tsx
import ApiDocs from './pages/ApiDocs';
```

Add the route inside `<Routes>`, next to the other account-tab pages:

```tsx
<Route path="/api-docs" element={<ApiDocs />} />
```

- [ ] **Step 5: Add the tab in `AccountTabs.tsx`**

```tsx
// ui/desktop/src/components/AccountTabs.tsx
const TABS = [
  { to: '/plan-quota', label: 'Plan & quota', icon: 'planQuota' as const },
  { to: '/pricing', label: 'Pricing', icon: 'pricing' as const },
  { to: '/progress', label: 'Progress', icon: 'progress' as const },
  { to: '/api-docs', label: 'API Docs', icon: 'help' as const },
  { to: '/help', label: 'Help', icon: 'help' as const },
];
```

- [ ] **Step 6: Add the footer link in `Layout.tsx`**

Find the footer's existing `<Link to="/help">` block and add a new link right before it:

```tsx
<Link to="/api-docs" className="text-muted">
  API Docs
</Link>
<Link to="/help" className="text-muted">
  Help
</Link>
```

- [ ] **Step 7: Add the Site Map entry**

In `ui/desktop/src/pages/SiteMap.tsx`, add to the `ACCOUNT` array:

```tsx
const ACCOUNT: SiteMapLink[] = [
  { to: '/plan-quota', label: 'Plan & quota', description: 'Check how much of your monthly Batch geocoding quota you have left.' },
  { to: '/pricing', label: 'Pricing', description: 'Buy additional monthly Batch geocoding quota.' },
  { to: '/progress', label: 'Progress', description: "A running record of what's shipped so far." },
  { to: '/api-docs', label: 'API Docs', description: 'Call the geocoding endpoints directly from your own code.' },
  { to: '/help', label: 'Help', description: 'How Meridian actually works, plus a way to send us feedback.' },
];
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd ui/desktop && npm test -- --run`
Expected: PASS, both `App.test.tsx` tests.

- [ ] **Step 9: Type-check**

Run: `cd ui/desktop && npx tsc -b`
Expected: no errors.

- [ ] **Step 10: Manual/live verification**

Start the local dev stack (`cd geocoding-server && node src/server.js` in one terminal, `cd ui/desktop && npm run dev` in another) and confirm in a browser:
- `http://localhost:5173/#/api-docs` renders with all five endpoints, real `curl` examples, and the rate-limit/error sections.
- Every link on the page (`Pricing`, `Plan & quota`, `Help`) actually navigates.
- The "API Docs" link appears in both the account tab strip and the site footer, and in Site Map.
- Copy one of the page's own `curl` examples and run it against the locally running server (`http://localhost:3001` instead of the production base URL) — confirm it returns the documented shape.

- [ ] **Step 11: Commit**

```bash
cd ui/desktop
git add src/pages/ApiDocs.tsx src/App.tsx src/App.test.tsx src/components/AccountTabs.tsx src/components/Layout.tsx src/pages/SiteMap.tsx
git commit -m "Add a public /api-docs page documenting all five geocoding endpoints"
```

---

## Final verification (after all three tasks)

- [ ] Run `cd geocoding-server && node --test` — full suite passes.
- [ ] Run `cd ui/desktop && npx tsc -b && npm test -- --run` — clean build, full suite passes.
- [ ] Re-run the exact Geocode/Reverse-geocode/Batch Playwright verification already done earlier this session (real UI, real file upload, real results) against the local dev stack, to confirm the optional-auth change didn't regress the site's own no-account usage.
- [ ] Deploy to `geocoding-test` (pull master, restart `geocoding-server`, confirm `api.test.meridiangeocoding.com` responds) once all three PRs are merged, same deploy process used throughout this session.
- [ ] On `geocoding-test`, `curl` `/geocode` 11+ times in under a minute from the same IP and confirm both the 429 response and the owner-notification email (Resend is already configured there) actually arrive.
