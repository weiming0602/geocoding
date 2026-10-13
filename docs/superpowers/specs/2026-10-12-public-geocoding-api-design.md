# Public Geocoding API — Design

## Problem

The geocoding engine is only reachable through `ui/desktop`'s batch-file
upload workflow — a customer who wants to geocode addresses as part of
their own software (a CRM, a logistics tool, a script) has no way to call
Meridian directly. They're forced to export addresses to a file, upload it
through the website, and re-import the results, even though the REST
endpoints those pages call (`/geocode`, `/geocode/batch`,
`/geocode/batch/download`, `/geocode/batch/email`, `/reverse-geocode`) already
exist in `geocoding-server/src/server.js` today.

This is about **productizing what's already there**, not building new
geocoding logic: access control (two of the five endpoints have none at
all right now) and documentation, so outside developers can self-serve
against the same API the website's own pages use.

## Scope

- **In scope:** auth/quota changes to `/geocode` and `/reverse-geocode`
  (currently fully open, no account, no limit); a new IP-based rate limiter
  for their unauthenticated path; a public docs page.
- **Out of scope:** `/geocode/batch`, `/geocode/batch/download`,
  `/geocode/batch/email` — already require `email`+`serviceKey`+quota, no
  changes needed. They're part of "the API" from a docs/marketing
  standpoint, but nothing about their access control changes here.
- **Out of scope:** any new auth *mechanism* (no `Authorization: Bearer`
  header, no API-key-in-URL, no OAuth). Every endpoint keeps using
  `email`+`serviceKey` as JSON body fields — identical to how batch already
  works, so `ui/desktop`/`ui/mobile` need zero changes.
- **Out of scope:** the separate LLM address-disambiguation sub-agent
  project the user also raised — explicitly a later, independent project
  that would consume this API as a client, not something built here.
- **Out of scope:** per-endpoint tiered pricing, usage analytics
  dashboards, webhooks, or any other "API platform" feature beyond what's
  specified below. YAGNI.

## Access model

### `/geocode/batch`, `/geocode/batch/download`, `/geocode/batch/email`

Unchanged. Already require `email`+`serviceKey` and spend the account's
existing per-period quota (`quota.js`'s `checkQuota`/`useQuota`).

### `/geocode`, `/reverse-geocode`

Currently: no auth, no quota, unlimited, forever. The site's own
`Geocode.tsx`/`ReverseGeocode.tsx` pages call these with no credentials at
all, and the Overview page explicitly promises *"Everything below works
without an account — a plan is only needed for batch geocoding past the
free tier."* That promise has to keep holding.

New behavior: **optional** `email`+`serviceKey` in the body.

- **Provided and valid** → same `checkQuota`/`useQuota` path batch already
  uses (`requestedCount`/`count` = 1), drawing from that account's paid
  quota. Not subject to the rate limiter below. This is the path a real
  API integration uses once it wants guaranteed throughput.
- **Omitted** → request proceeds exactly as today (free, no account), but
  is now subject to the per-IP rate limiter below. This is the path
  `Geocode.tsx`/`ReverseGeocode.tsx` keep using unchanged, and the only
  path a casual/anonymous API caller gets.
- **Provided but invalid** (unknown email, wrong key) → same
  `UnauthorizedError`/404 behavior `checkQuota` already produces for batch
  — a caller that *tries* to authenticate and fails doesn't silently fall
  back to the free/anonymous path.

No changes needed to `Geocode.tsx` or `ReverseGeocode.tsx` — they already
send no `email`/`serviceKey`, which is exactly the free path. Confirmed
the same holds for `ui/mobile`'s `GeocodeForm.tsx`/`ReverseGeocodeForm.tsx`
— neither references `email`/`serviceKey` either, so this is a
zero-client-change migration for both frontends, not just desktop.

## Rate limiting (unauthenticated `/geocode`/`/reverse-geocode` only)

**Threshold:** more than 10 requests in a rolling ~60-second window from
the same IP. **Consequence:** blocked from further unauthenticated calls
for the rest of the UTC calendar day — not just until the window rolls
over. **Why a persistent table, not in-memory:** a day-long block has to
survive a `systemctl restart geocoding-server` (a routine deploy
operation, see every PR this session), and the existing `geocode`
(read-only) database isn't where account/access state lives — this
follows `transactions`/`road_alerts_push_subscriptions`'s own precedent of
living in `geocoding_users` instead.

```sql
CREATE TABLE IF NOT EXISTS geocode_rate_limits (
  ip_address TEXT NOT NULL,
  date DATE NOT NULL,                   -- UTC calendar day; new day = new row = fresh window
  window_started_at TIMESTAMPTZ NOT NULL,
  window_count INTEGER NOT NULL,        -- requests in the current ~60s window
  total_count INTEGER NOT NULL,         -- full day's request count, for monitoring
  blocked_at TIMESTAMPTZ,
  PRIMARY KEY (ip_address, date)
);
```

New module `geocodeRateLimit.js`, mirroring `quota.js`'s shape:

```js
async function checkRateLimit(pool, ipAddress) {
  const today = new Date().toISOString().slice(0, 10); // UTC date
  const { rows } = await pool.query(
    `INSERT INTO geocode_rate_limits (ip_address, date, window_started_at, window_count, total_count)
     VALUES ($1, $2, now(), 1, 1)
     ON CONFLICT (ip_address, date) DO UPDATE SET
       window_count = CASE
         WHEN geocode_rate_limits.window_started_at <= now() - interval '1 minute'
           THEN 1
         ELSE geocode_rate_limits.window_count + 1
       END,
       window_started_at = CASE
         WHEN geocode_rate_limits.window_started_at <= now() - interval '1 minute'
           THEN now()
         ELSE geocode_rate_limits.window_started_at
       END,
       total_count = geocode_rate_limits.total_count + 1
     RETURNING *`,
    [ipAddress, today]
  );
  const row = rows[0];

  if (row.blocked_at) {
    throw new RateLimitError(
      'Rate limit exceeded: unauthenticated requests are limited to 10/minute. ' +
      "You're blocked from further anonymous requests for the rest of today -- " +
      'sign up for a free account to get a service key for uninterrupted access.'
    );
  }

  if (row.window_count > 10) {
    await pool.query(
      `UPDATE geocode_rate_limits SET blocked_at = now() WHERE ip_address = $1 AND date = $2`,
      [ipAddress, today]
    );
    await sendRateLimitBlockedNotification({ ipAddress, totalCount: row.total_count });
    throw new RateLimitError(
      'Rate limit exceeded: unauthenticated requests are limited to 10/minute. ' +
      "You're blocked from further anonymous requests for the rest of today -- " +
      'sign up for a free account to get a service key for uninterrupted access.'
    );
  }
}
```

The single `INSERT ... ON CONFLICT DO UPDATE` atomically handles both "new
IP today" and "existing IP, roll or extend the window" in one round trip —
no separate read-then-write race between concurrent requests from the
same IP.

`errors.js` gains `RateLimitError`, mapped to **HTTP 429** in both route
handlers (same per-error-class `instanceof` dispatch every other endpoint
already uses).

**Owner notification on block:** reuses the exact pattern from
`sendTransactionsDigestEmail`/`sendBatchRunNotification` (PR #79) — a new
`sendRateLimitBlockedNotification` in `emailDelivery.js`, same
`TRANSACTIONS_NOTIFY_EMAIL` recipient, same stub-when-unconfigured
convention, fired once at the moment an IP crosses the threshold (not
once per subsequent rejected request — `blocked_at` already being set is
what's checked first, so this only fires exactly once per IP per day).
This is the "monitor the user's activities" requirement — the owner sees
abuse in near-real-time instead of having to query the table by hand.

**Pruning:** rows older than 14 days get deleted, same retention window
`ops/backup-databases.sh` already uses elsewhere. Folded into the existing
`scripts/cleanup-feedback.js`-style periodic script rather than a new one
— see implementation plan for whether that's literally the same script or
a sibling one.

## `req.ip` / reverse proxy

Confirmed directly against the `geocoding-test` droplet's nginx config:
`proxy_set_header X-Real-IP $remote_addr;` and
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` are already
present. Express needs `app.set('trust proxy', 'loopback')` (nginx runs on
the same box, i.e. always connects from `127.0.0.1`) added once near the
other `app.set`/`app.use` calls in `server.js` — without it, `req.ip`
resolves to nginx's own loopback address instead of the real client IP,
and every unauthenticated caller would silently share one rate-limit
bucket.

## Architecture summary

- `geocoding-server/src/geocodeRateLimit.js` (new): `ensureGeocodeRateLimitsTable`,
  `checkRateLimit`, following `quota.js`'s existing module shape.
- `geocoding-server/src/errors.js`: add `RateLimitError`.
- `geocoding-server/src/emailDelivery.js`: add `sendRateLimitBlockedNotification`.
- `geocoding-server/src/server.js`:
  - `app.set('trust proxy', 'loopback')` once, near startup.
  - `POST /geocode` and `POST /reverse-geocode` handlers gain the
    optional-auth branch described above.
  - Both gain a `RateLimitError` → 429 branch in their existing
    `instanceof` error dispatch.
  - `usersDbPromise`'s startup chain gains
    `ensureGeocodeRateLimitsTable(pool)`, same as every other
    `ensureXTable` call already there.
- `ui/desktop`: new `/api-docs` route + page (see below). No changes to
  `Geocode.tsx`/`ReverseGeocode.tsx`/`Batch.tsx` — all three keep working
  exactly as verified live this session (file upload → submit → real
  results, quota correctly decremented).

## Public docs page

New `/api-docs` route on `ui/desktop`, matching the site's existing design
system (same `PageHeader`/card conventions every other page already
uses) — no new infrastructure, same build/deploy pipeline. Content:

- The five endpoints, grouped as "single lookups" (`/geocode`,
  `/reverse-geocode`) and "batch" (the three `/geocode/batch*` routes).
- Auth: `email`+`serviceKey` as JSON body fields, with a note that the two
  single-lookup endpoints work without them (rate-limited) or with them
  (metered, higher volume).
- One `curl` example per endpoint, request/response JSON shapes.
- The rate-limit behavior and 429 response shape for anonymous calls.
- A link to `/pricing` for getting a service key.

Linked from the main nav (`Layout.tsx`) and the Overview page, alongside
the existing "no API key application to wait on" copy — that copy itself
doesn't need to change, since nothing about today's free/no-account
promise is being removed.

## Data flow, end to end

**Anonymous caller, under the limit:**
1. `POST /geocode` with just `{ address }`, no credentials.
2. `checkRateLimit` upserts today's row for their IP, `window_count` is
   under 10 → proceeds.
3. Geocodes, returns the result. No quota touched anywhere.

**Anonymous caller, crosses the threshold:**
1. Their 11th request in under a minute arrives.
2. `checkRateLimit`'s upsert pushes `window_count` to 11, the handler sets
   `blocked_at = now()`, fires the owner notification, throws
   `RateLimitError`.
3. Route handler catches it, responds 429 with the warning message.
4. Every further unauthenticated request from that IP today hits the
   `blocked_at IS NOT NULL` check first and is rejected immediately, no
   window math needed.
5. Next UTC day: a request from that IP has no row for today's date yet →
   fresh start.

**Authenticated API caller:**
1. `POST /geocode` with `{ address, email, serviceKey }`.
2. `checkQuota` runs (existing batch logic, `requestedCount: 1`) — 401/404
   for bad credentials, 429 `QuotaExceededError` if the period's quota is
   exhausted.
3. Geocodes, `useQuota` spends 1 from the account's period, returns the
   result. Never touches `geocode_rate_limits` at all.

## Testing strategy

- **Server:** unit tests for `geocodeRateLimit.js` (fresh IP passes
  through; window resets after 60s via a mocked/injectable clock, same
  pattern `roadAlertsPush.js`'s staleness tests already use; crossing 10
  in-window sets `blocked_at` and fires the notification exactly once; a
  second request after blocking is rejected without incrementing
  `total_count` further or re-notifying).
- **Server:** endpoint tests for `/geocode`/`/reverse-geocode` covering
  all three auth branches (no credentials + under limit → 200; no
  credentials + over limit → 429; valid credentials → quota path, same
  assertions `batchGeocodeContent.test.js` already makes for batch).
- **Server:** confirm `trust proxy` is actually wired — a test that sets
  `X-Forwarded-For` on a request and asserts `checkRateLimit` sees that
  IP, not `127.0.0.1`.
- **Manual/live verification** (required before calling this done, same
  standard as every change this session): re-run the exact
  Geocode/Reverse-geocode/Batch Playwright verification already done
  today against `geocoding-test` after deploy, plus a real `curl` loop
  hitting `/geocode` 11+ times in under a minute to confirm the 429 and
  the owner-notification email both actually fire.

## Open questions

- **Pruning script**: fold `geocode_rate_limits` cleanup into
  `scripts/cleanup-feedback.js` directly (rename/generalize it) or add a
  small sibling script — implementation plan should pick one; either is a
  few lines given the existing `>N days` deletion pattern.
- **`/api-docs` page content depth**: this spec describes its sections but
  not exact copy/wording — written during implementation, not blocking
  design approval.
