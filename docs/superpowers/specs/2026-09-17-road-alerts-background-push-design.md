# Road Alerts Background Push Alerts — Design

## Problem

PR #62 added a chime + browser `Notification` for `serious`/`need_to_know`
Road Alerts, but only while a tab is open (foreground or backgrounded, not
closed). On iOS Safari specifically, the gap is total: **Safari does not
support the `Notification` API at all in a normal browser tab**, installed
or not, so an iPhone user driving with the tab closed (or the phone locked)
never gets any signal beyond the spoken alert, which only plays while the
tab is open and the phone unlocked.

iOS also has no background/periodic-sync API a closed tab could use to
"wake up" and re-check hazards on its own. The only way to alert a closed
app on iOS at all is a real **Web Push** message, sent from a server,
routed through Apple's push service — which requires the site to be
installed to the Home Screen (a real PWA) and running in that installed
mode at least once to complete the push subscription.

## Scope

- **In scope:** desktop web app (`ui/desktop`) only, same as PR #62.
- **In scope:** installable PWA (manifest + service worker) — a real
  install prompt on desktop too, not just infrastructure for iOS.
- **In scope:** server-triggered push for `serious`/`need_to_know` alerts,
  using a driver's ephemeral last-known position (Approach A, see below).
- **Out of scope:** `ui/mobile` — that app has its own native notification
  capability entirely separate from this browser-based feature; not
  touched here.
- **Out of scope:** replacing PR #62's chime/in-tab notification — this is
  an *additional* delivery path for installed-PWA users, not a
  replacement. A user who never installs the app keeps exactly today's
  behavior.
- **Out of scope:** offline caching / "app works with no network" PWA
  behavior. The service worker exists here only to receive pushes; a
  Workbox-style precache strategy is a separate, later decision.

## Why this needs a live position on the server at all

Web Push fundamentally requires the *send* step to go through a server —
a browser cannot push a notification to its own closed instance without
one. But "server sends *something*" and "server knows where the driver
currently is" are separable — the harder question is whether the server
needs live position at all, or whether the client could decide "send a
push now" while still holding the matching logic itself.

It can't, for a closed tab: if the client is closed, no client-side code
is running to make that decision. Something has to independently know
"is a `serious`/`need_to_know` hazard near this specific driver's current
position and route" without asking the (closed) client — and the only
thing capable of that is the server itself, which means the server needs
*some* live signal of the driver's position while they are actively
driving.

## Approach: ephemeral single last-known point (Approach A)

Rather than mirroring the client's full GPS trail server-side, the server
receives only the driver's **current position**, overwriting the previous
value each update, never appended to a history:

- While "Road Alerts" is running (from pressing Start to pressing Stop, or
  a hard timeout — see below), the client periodically sends its current
  `{ latitude, longitude, heading }` to the server.
- The server keeps only the **single most recent point** per account —
  logically a row (or in-memory entry) that gets overwritten in place, not
  a new row per update.
- The point is discarded (not merely stale) the moment the driver presses
  Stop, and independently expires after a short timeout (**10 minutes** of
  no update) in case Stop is never pressed (tab killed, phone locked and
  the app backgrounded without a clean stop).
- Nothing here is ever written to a durable trip log, and no history of
  points is ever retained — this preserves the "no raw trip trace stored"
  principle's *spirit* (no travel history exists at rest) while
  necessarily introducing a new, genuinely different thing: a live,
  transient point that exists on the server for as long as the drive is
  ongoing.

This is a real, deliberate expansion of what leaves the browser, and gets
its own explicit callout in `docs/ROAD_ALERTS_DESIGN.md`'s Privacy model
section (see Task in the implementation plan) rather than being folded
into the existing addendum silently.

## Architecture

### 1. PWA installability (frontend)

- Add `vite-plugin-pwa` to `ui/desktop` — the standard, idiomatic way to
  get a manifest + service worker out of a Vite project without hand-
  rolling either. Configured in `injectManifest` mode (not
  `generateSW`/Workbox precaching) since this app has no offline-caching
  requirement yet — the service worker's only job is to exist and handle
  `push`/`notificationclick` events.
- `manifest.json`: name "Meridian", `display: "standalone"`, theme/
  background colors matching the existing gold (`#f2a52d`) branding,
  icons at 192×192 and 512×512 (generated from the existing logo asset).
- `index.html` gets the iOS-specific meta tags Apple's Home Screen install
  still keys off of independently of the manifest
  (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  `apple-touch-icon`).
- A custom service worker source file (`src/sw.ts`, built by
  `vite-plugin-pwa`'s `injectManifest` mode) with two listeners:
  - `push`: parses the payload, calls `self.registration.showNotification(title, { body })`.
  - `notificationclick`: focuses an existing client window if one is open,
    otherwise opens a new one to the Road Alerts page; closes the
    notification either way.
- Registration happens once, from `main.tsx`, guarded the same
  "unsupported = silent no-op" way as `roadAlertNotifications.ts` —
  browsers without service worker support (there are effectively none
  left, but the guard costs nothing) simply never register one.

### 2. Push subscription (frontend + backend)

- On pressing Start, after `requestNotificationPermission()` (existing,
  PR #62) succeeds, additionally check `isPushCapable()` (a new function:
  `'serviceWorker' in navigator && 'PushManager' in window`) — this is
  `false` on iOS Safari unless the page is currently running in installed
  (Home Screen) mode, which is exactly the gate we want: no point asking
  for a push subscription from a regular iPhone Safari tab, since it will
  simply fail.
- If push-capable: `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID public key> })`
  returns a `PushSubscription` (an `endpoint` URL plus `p256dh`/`auth`
  keys). POST it to a new endpoint: `POST /road-signals/push-subscribe`
  (body: `{ email, serviceKey, subscription }`, same account-auth shape as
  every other Road Alerts account-scoped endpoint —
  `roadAlertsAccounts.js`'s `checkAccess`).
- Server stores it in a new table, keyed to the existing
  `road_alerts_accounts.id`:

  ```sql
  CREATE TABLE IF NOT EXISTS road_alerts_push_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES road_alerts_accounts(id),
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, endpoint)
  );
  ```

  `UNIQUE (account_id, endpoint)` with `ON CONFLICT DO NOTHING` makes
  re-subscribing (e.g. re-granting permission after a browser data clear)
  idempotent, same pattern as `registerAccount`'s `ON CONFLICT`. One
  account can hold multiple subscriptions (e.g. an installed PWA on both
  an iPhone and a laptop) — pushes go to all of them.

### 3. Ephemeral live position (frontend + backend)

- While driving (Start pressed, push-capable, and a subscription exists),
  the client sends its current position on the **same cadence it already
  polls hazards** (today's existing interval) via a new endpoint:
  `POST /road-signals/live-position` (body: `{ email, serviceKey, latitude, longitude, heading }`).
- Server holds this as a single row per account, upserted every call —
  never inserted as a new row:

  ```sql
  CREATE TABLE IF NOT EXISTS road_alerts_live_positions (
    account_id BIGINT PRIMARY KEY REFERENCES road_alerts_accounts(id),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    heading DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```

  `account_id PRIMARY KEY` (not a surrogate id) is what makes "one row per
  account, always overwritten" structural rather than a convention to
  remember — an `INSERT ... ON CONFLICT (account_id) DO UPDATE` upsert.
- On pressing Stop, the client calls a new `DELETE /road-signals/live-position`
  to remove the row immediately, rather than waiting for the timeout.
- A row older than **10 minutes** (`updated_at`) is treated as stale by
  the matching loop below and skipped — cheap to check inline (`WHERE
  updated_at > now() - interval '10 minutes'`) rather than a separate
  cleanup job; a stale row left behind by an unclean disconnect is
  harmless (never matched, never displayed anywhere) and can be swept by
  the existing `cleanup-feedback.js`-style periodic script if it ever
  matters, but isn't needed for correctness.

### 4. Matching + push-send loop (backend)

- Reuses `ui/shared/roadAlertsMatching.ts` directly from Node — confirmed
  to have zero browser-only dependencies (pure math over `geo.ts`). A new
  `geocoding-server/src/roadAlertsPush.js` module requires it exactly as
  `ui/desktop`/`ui/mobile` already import it, no porting/duplication.
- **Correction from an earlier draft of this section**: `roadSignals.js`'s
  hazard cache (`NETWORK_CACHE_TTL_MS`, 60s) is refreshed *lazily* — only
  when an incoming client request finds it stale — there is no existing
  independent server-side timer to "reuse." That matters here specifically
  because the whole point of this feature is alerting a driver with **no
  open tab**, i.e. potentially the only thing still "asking" for hazard
  data at all. So this loop must be a genuinely new `setInterval`, running
  on its own fixed cadence matching the existing cache TTL (**60s**), that
  calls the same cached-fetch function every client request already goes
  through (`fetchNetworkIncidentsCached` et al.) — this loop's own tick is
  what keeps the hazard cache populated even when zero browser tabs are
  open, not merely a consumer riding along on an existing schedule.
- For each non-stale row in `road_alerts_live_positions`:
  1. Look up that account's weighted points (`weightedPoints.js`, already
     exists) and current hazards (already fetched for the existing
     hazard-serving path — this loop reuses that in-memory result rather
     than re-fetching).
  2. Run `approachedWeightedPoints`/the existing route-approach matching
     against the account's single live point (a trail of length 1 is a
     valid, already-handled input shape — `roadAlertsMatching.ts` falls
     back to unfiltered pass-through below its 2-sample minimum, i.e. this
     naturally degrades to plain proximity-based matching rather than
     erroring).
  3. For each resulting hazard where `severity` is `serious` or
     `need_to_know` (mirrors `shouldStronglyAlert` — this constant moves
     to `ui/shared` so both the client and server import the same
     definition instead of duplicating it):
     - Skip if this exact `(account_id, hazard_id)` pair was already
       pushed (see de-duplication below).
     - Otherwise, send a push via `web-push` to every subscription row for
       that account.

### 5. De-duplication

- A new table tracks what's already been pushed, so a hazard doesn't
  re-fire every cycle for the same account while it's still active and
  the driver is still near it:

  ```sql
  CREATE TABLE IF NOT EXISTS road_alerts_push_sent (
    account_id BIGINT NOT NULL REFERENCES road_alerts_accounts(id),
    signal_id TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, signal_id)
  );
  ```

- A row here is cleared when the account's live-position row is deleted
  (Stop pressed / timeout) — a new drive starts with a clean slate, so the
  same hazard can alert again on a later trip. Not a foreign-key `ON
  DELETE CASCADE` (the two tables share `account_id` but there's no FK
  relationship between them to hang a cascade off) — instead, both the
  `DELETE /road-signals/live-position` handler and the matching loop's own
  staleness check delete this account's `road_alerts_push_sent` rows
  (`WHERE account_id = $1`) in the same step that removes/notices the
  expired live-position row.

### 6. Server setup

- New dependency: `web-push` (npm, MIT-licensed) — generates/validates
  VAPID signatures and performs the actual authenticated POST to each
  push service (Apple's, Google's, Mozilla's — `web-push` abstracts over
  all of them via the subscription's own `endpoint` URL).
- New env vars, all required only if this feature is to work (silently
  inert otherwise, same "unset = disabled" convention as `HERE_API_KEY`):
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (generated once via `npx web-push generate-vapid-keys`,
  stored in each droplet's `.env`, **not** committed), `VAPID_SUBJECT`
  (a `mailto:` contact address the push spec requires).
- The public key alone (not the private key) is also needed client-side,
  to pass as `applicationServerKey` — exposed via a new, unauthenticated
  `GET /road-signals/push-public-key` endpoint (a public key is not a
  secret; this avoids hardcoding it into the frontend build and needing a
  rebuild if it's ever rotated).

## Data flow, end to end

1. Driver installs the PWA (Home Screen, iOS; or the browser's native
   install prompt, desktop/Android).
2. Driver opens the installed app, presses Start. Notification permission
   granted → push subscription created → POSTed to
   `/road-signals/push-subscribe`.
3. While driving, the client POSTs its position to `/road-signals/live-position`
   on the existing hazard-poll cadence.
4. Driver locks their phone / closes the tab. The server still holds their
   last-known position (until it goes stale or Stop was pressed before
   closing).
5. The server's hazard-refresh cycle runs, notices a new `serious` hazard
   is now on this account's matched route, hasn't been pushed yet for
   this account → sends a push via `web-push`.
6. The OS delivers it (Apple Push Notification service, under the hood)
   to the installed PWA's service worker, even though the app isn't
   running. The `push` event handler shows the OS notification.
7. Driver taps it → `notificationclick` focuses/opens the app.

## Privacy model — required documentation update

`docs/ROAD_ALERTS_DESIGN.md`'s Privacy model section gets a new addendum
(dated to this spec), parallel in structure to the existing 2026-09-12
route-approach addendum, explicit that:

- This is a **new category** of data leaving the browser — a live,
  single point, not a trail, not a trip history.
- It exists on the server **only while a drive is actively in progress**
  (Start pressed → Stop pressed or a 10-minute inactivity timeout),
  is **never appended to any history table**, and is deleted (not merely
  marked inactive) on Stop.
- It is **opt-in twice over**: only sent at all if the driver has
  installed the app *and* granted notification permission — a driver who
  never installs the PWA sends no live position, ever, and keeps exactly
  today's (PR #62) behavior.

## Testing strategy

- **Server:** unit tests for `push-subscribe`/`live-position` endpoints
  (account auth reuse, upsert idempotency, deletion), the matching+push
  loop (mock `web-push.sendNotification`, assert it's called for a
  `serious` match and not for a `proximity` one, assert de-duplication
  skips a repeat), and staleness handling (a >10-minute-old row is
  skipped and its dedup rows cleared).
- **Client:** the existing "graceful no-op when unsupported" pattern
  (`roadAlertNotifications.test.ts`-style) extended to
  `isPushCapable()`/subscribe flow — can't test the real permission
  dialog or actual push delivery in an automated test, same limitation
  PR #62 already accepted for `Notification`.
- **Manual verification** (required before calling this done, same as
  every browser-permission-gated feature this session): install the PWA
  on an actual iPhone, grant notification permission, start driving mode,
  background the app, and confirm a push arrives for a `serious`/
  `need_to_know` hazard.

## Open questions

- **Icon assets**: this spec assumes existing brand assets can be
  exported at 192×192/512×512: needs the actual PNG exports before
  implementation, not a design blocker.
- **Push service outage/failure handling**: `web-push` throws on a
  send failure (e.g. an expired/revoked subscription, HTTP 410 Gone) —
  the plan should have the matching loop delete a subscription row on a
  410 specifically (the browser unsubscribed, unrecoverable), while
  logging-and-continuing on any other error (a transient push-service
  hiccup shouldn't drop the whole cycle's remaining accounts).
