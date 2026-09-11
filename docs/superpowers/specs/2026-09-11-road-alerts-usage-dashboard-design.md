# Road Alerts provider usage stats on the owner dashboard

**Status:** approved design, not yet implemented.
**Motivation:** the owner dashboard (`ui/desktop/src/pages/OwnerDashboard.tsx`,
passcode-gated via `GET /admin/transactions`'s `ADMIN_PASSCODE`) currently shows
billing/transaction stats only. There is no visibility into how much the app actually
calls its two Road Alerts hazard providers — New England 511 (free) and HERE Traffic API
(paid, 30,000 transactions/month free tier — see
`docs/superpowers/specs/2026-09-10-here-traffic-provider-design.md`). A recent
whole-branch review flagged that this app currently has no caching on the HERE path
despite 15-second client polling, and estimated real usage could approach the free
tier's ceiling — this feature gives the owner the actual numbers instead of a rough
estimate, and separates that view from the existing Transactions section behind an
in-page tab.

## Decisions made during brainstorming

- **Storage: a persistent Postgres table in `geocoding_users`**, not an in-memory
  counter — survives restarts/deploys, matches the existing `transactions` table's
  precedent for "real record you can look back on."
- **What counts as a "call": real upstream fetches only, post-cache.** A request served
  from New England 511's existing 15-second in-memory cache (`fetchNetworkIncidentsCached`
  in `roadSignals.js`) does not count — only an actual network round-trip to the
  provider does. This is what matters for HERE's paid quota, and gives an honest
  picture rather than one inflated by repeat client polling.
- **Time granularity: row-per-call, not pre-aggregated.** One row per real upstream
  call, so today/this-month/all-time (or any other window) is a query-time `WHERE
  created_at >= ...`, not a schema decision made upfront. HERE's quota is monthly;
  New England 511 has no quota concept at all — showing multiple windows side by side
  is more useful than committing to one.

## Data model

New `geocoding-server/src/providerCallLog.js`, same style as `transactions.js`:

```sql
CREATE TABLE IF NOT EXISTS provider_call_log (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,      -- 'ne511' | 'here'
  network TEXT,                -- 'Maine' | 'NewHampshire' | 'Vermont' for ne511;
                                -- always null for here (HERE has no sub-networks)
  success BOOLEAN NOT NULL,    -- records failures too, so the dashboard can also
                                -- surface "511 has been erroring a lot today"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_call_log_created_at_idx ON provider_call_log (created_at DESC);
```

`recordProviderCall(pool, { provider, network, success })` is the only write path —
a normal function that can throw on a real DB failure, same as every other
`recordX`/`insertX` function in this codebase. It is **not** self-swallowing.
Non-blocking behavior lives at each call site instead, wrapped in its own try/catch
that `console.error`s and continues — the exact pattern `server.js`'s
`/road-alerts/email-alert` route already uses around `insertSurfacedAlert`
(`roadAlertsSurfacedLog.js`): "Logging is purely additive... a logging failure
shouldn't fail a request the user is already waiting on, so it's caught and reported
here rather than thrown." `recordProviderCall` itself stays a plain, easily-testable
function; each of the (few) call sites in `roadSignals.js`/`hereTraffic.js` decides to
treat a logging failure as non-fatal, matching that established convention rather than
inventing a new one.

`getProviderCallCounts(pool)` returns counts grouped by provider across three windows
(today, this calendar month, all-time), e.g.:

```js
{
  ne511: { today: 42, thisMonth: 891, allTime: 14203 },
  here: { today: 118, thisMonth: 2456, allTime: 2456 },
}
```

## Instrumentation: threading `usersDb` into the fetch functions

The real wrinkle. `roadSignals.js`'s `fetchNetworkIncidents`/`fetchNetworkIncidentsCached`
and `hereTraffic.js`'s `fetchHereIncidents`/`getHereIncidents` currently have no
parameter for the `geocoding_users` pool at all — they only know about the read-only
`geocoding` pool (or nothing, in `hereTraffic.js`'s case). Recording "real upstream
fetch, post-cache" precisely requires recording right at these fetch call sites — the
`GET /road-signals` route can't do it from outside, since it can't tell which of New
England 511's 3 networks hit cache vs. genuinely fetched.

Fix: thread the `usersDb` pool in as the first parameter of each function that can
reach a real fetch, matching this codebase's existing pool-first convention (e.g.
`checkQuota(usersDb, ...)`, `quota.js`):

- `roadSignals.js`: `getRoadSignals(usersDb, { latitude, longitude, radiusMeters })`,
  `fetchNetworkIncidentsCached(usersDb, network)`, `fetchNetworkIncidents(usersDb,
  network)`. `fetchNetworkIncidents` wraps a `recordProviderCall` call (in its own
  try/catch, `console.error`-and-continue on failure) right before each `throw new
  UpstreamError(...)` (both the network-level catch and the non-2xx-response case, each
  with `success: false`) and once right after confirming `response.ok` (`success:
  true`), before doing the (unrelated) XML parsing work. A cache hit inside
  `fetchNetworkIncidentsCached` never reaches `fetchNetworkIncidents` at all, so it
  correctly records nothing.
- `hereTraffic.js`: `getHereIncidents(usersDb, { latitude, longitude, radiusMeters })`,
  `fetchHereIncidents(usersDb, latitude, longitude, radiusMeters)`. Same pattern: a
  try/catch-wrapped `recordProviderCall` with `success: false` at each of the three
  existing `UpstreamError` throw points (`fetch()` itself failing, non-2xx response,
  and the `response.json()`/`.map()` failure case fixed by the earlier final-review fix
  wave), `success: true` right after a valid, parseable response.
- `server.js`: the one `getRoadSignals({...})` call site (`GET /road-signals`, already
  has `usersDb` in scope from `checkRoadAlertsAccess`) becomes `getRoadSignals(usersDb,
  {...})`.

This changes 5 existing function signatures. `roadSignals.test.js` is unaffected —
it never calls `getRoadSignals`/`fetchNetworkIncidents(Cached)` directly, only the
provider-agnostic pieces already living in `roadSignalsShared.js`. `hereTraffic.test.js`
**does** call `getHereIncidents`/`fetchHereIncidents` directly and needs updating: those
specific tests gain a real throwaway `usersDb` via `makeUsersDb()` (the same pattern
`weightedPoints.test.js`/`roadAlertsAccounts.test.js` already use), which also creates a
natural opportunity to assert the log row actually landed — real coverage, not just a
signature accommodation. `roadSignalsEndpoint.test.js`'s route-level tests are
unaffected by the signature change itself (they go through the real HTTP route, which
already has `usersDb` in scope), but gain a new test asserting a successful request
writes a `provider_call_log` row.

## API

New `GET /admin/road-alerts-usage?passcode=...`, same `ADMIN_PASSCODE` gate and error
shape as the existing `GET /admin/transactions` (401 for a missing/wrong/unset
passcode, never "misconfigured, so let it through"). Returns
`getProviderCallCounts`'s shape directly:

```json
{ "ne511": { "today": 42, "thisMonth": 891, "allTime": 14203 },
  "here": { "today": 118, "thisMonth": 2456, "allTime": 2456 } }
```

## UI

`OwnerDashboard.tsx` gains an in-page segmented toggle using the existing `.seg`/
`.seg-opt` CSS pattern (already used by `Help.tsx`, `RoadAlerts.tsx`,
`RoadAlertsSandbox.tsx` for exactly this "switch what's shown on one page" case — not
`BatchTabs.tsx`/`AccountTabs.tsx`'s page-level route tabs, which don't apply since
`/owner` is a single route). Two segments:

- **Transactions** (default, selected on load) — today's existing content unchanged:
  the 4 stat cards, transactions table, recent-activity table.
- **Road Alerts** — new. Two stat-card rows (or one row per provider, each showing
  today/this-month/all-time), New England 511 and HERE side by side, so the owner can
  see HERE's usage against its monthly quota at a glance. Fetched via a new
  `getRoadAlertsUsage(passcode)` in `ui/shared/api/client.ts`, loaded once the segment
  is first selected (not on every page load — this data changes slowly, and the
  Transactions tab is the default view most visits will actually want).

## Testing plan

- `providerCallLog.js`: new `test/providerCallLog.test.js`, same shape as
  `weightedPoints.test.js` — `recordProviderCall` inserts a row with the right fields
  (and, as a normal DB function, rejects on a real failure -- e.g. an invalid `provider`
  value if a check constraint is added, or simply a closed pool -- rather than
  swallowing it itself); `getProviderCallCounts` correctly buckets rows into
  today/this-month/all-time using real backdated `created_at` values (mirroring how
  `weightedPoints.test.js` backdates `window_started_at`/`last_pinged_at` to test its
  own time-windowed logic).
- `hereTraffic.test.js`: existing `getHereIncidents`/`fetchHereIncidents` tests updated
  to pass a real `usersDb` (`makeUsersDb()`), with new assertions that a successful call
  writes one `provider_call_log` row (`provider: 'here'`, `network: null`, `success:
  true`) and a failed call writes one with `success: false`.
- `roadSignalsEndpoint.test.js`: new test asserting a successful `GET /road-signals`
  request against a New England 511 location writes the expected per-network rows to
  `provider_call_log`.
- New `test/adminRoadAlertsUsageEndpoint.test.js` (or added to an existing admin-route
  test file): `GET /admin/road-alerts-usage` requires the correct passcode (401
  otherwise, same as `/admin/transactions`), and returns accurate counts against
  seeded `provider_call_log` rows.
- `ui/desktop`: no test-suite entry exists for `OwnerDashboard.tsx` today (its own test
  file, if one existed, isn't part of this app's real `npm test` — see `CLAUDE.md`'s
  note that only `App.test.tsx`/`ImportAddresses.test.tsx` are real desktop tests), so
  no new desktop test is added for the UI change itself; `tsc --noEmit` and a manual
  check are the verification for that half.
