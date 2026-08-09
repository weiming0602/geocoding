# geocoding

Custom address geocoding engine for Maine (+ NH) built on Census TIGER/Line
`edges` shapefiles — no third-party geocoding API. Sub-projects in one
repo: `geocoding/` (Python: shapefile → Postgres/PostGIS ingest +
interpolation), `geocoding-server/` (Express API), `ui/mobile/`
(Expo/React Native app), `ui/desktop/` (React web app).
`geocoding-server/README.md` documents the matching/interpolation
algorithm in detail — read that before touching `geocode.js` or
`interpolate.py`. `DATA_SOURCES.md` documents where the underlying data
itself comes from (TIGER/Line, Maine E911), its licensing, and how it
stays current — read that before answering any question about data
provenance/licensing or touching the ingest pipeline. Two Postgres
databases: `geocoding` (streets/street_names, read-only from the
server) and `geocoding_users` (subscriptions/quota/feedback,
read-write).

# Bash commands
- Python: `.venv\Scripts\python -m geocoding.update_state "dbname=geocoding" --state ME`
  (venv is Windows-style `Scripts\`, not `bin/`; DSN is a psycopg
  connection string, e.g. `dbname=geocoding user=my_ai`)
- Annual maintenance (all states' TIGER/Line streets + Maine's E911 address
  points, insert-only/safe to re-run): `.venv\Scripts\python -m
  geocoding.annual_update "dbname=geocoding"` -- see `ops/` for the
  systemd timer/service pair and a crontab alternative to schedule it.
- Python tests: `.venv\Scripts\python -m pytest` (37 tests in `tests/`) —
  each test creates and drops its own throwaway Postgres database (see
  `tests/conftest.py`'s `dsn` fixture)
- Server: `cd geocoding-server && node src/server.js` -- for anything
  beyond local dev (i.e. actually deployed), run it via `ops/
  geocoding-server.service` instead: restarts on crash/reboot, and
  captures stdout (morgan's per-request log lines, plus every existing
  `console.log`/`console.error`) durably via journald instead of an
  ephemeral terminal or `/tmp` file.
- Server tests: `cd geocoding-server && node --test` — **not** `npm test`,
  that script is a placeholder stub. 155 tests, same throwaway-database-
  per-test pattern (see `test/helpers.js`); 1 pre-existing failure on
  non-Windows boxes (`zip.test.js`'s PowerShell-extraction check, `spawnSync
  powershell.exe ENOENT`) is expected and unrelated to any change here.
- Database backup (pg_dumps `geocoding` + `geocoding_users` -- the
  latter has real customer accounts/service keys/quota/feedback, not
  reconstructable from anywhere else -- to `~/backups/geocoding`,
  pruning anything older than 14 days): `ops/backup-databases.sh` -- see
  `ops/` for the systemd timer/service pair and a crontab alternative.
  Local-disk-only as-is; see the script's own header for what changes
  once this is actually deployed.
- Feedback cleanup (deletes comments older than N days, default 90):
  `cd geocoding-server && node scripts/cleanup-feedback.js [days]` -- see
  `ops/` for the systemd timer/service pair and a crontab alternative.
- Mobile app: `cd ui/mobile && npm start`
- Desktop app: `cd ui/desktop && npm run dev`

# Code style
- Odd/even house-number convention (odd → left range/offset left, even →
  right range/offset right) is implemented independently in both
  `geocoding/interpolate.py` and `geocoding-server/src/geocode.js`. If you
  change the rule, change it in both places.
- `geocode.js` queries `UPPER(fullname)`; there's a matching expression
  index in `schema.py`. Don't drop or rename either without checking the
  other — without the index, batch geocoding is ~10x slower.
- `geocoding-server/src/geocode.js`, `reverseGeocode.js`, `users.js`,
  `quota.js`, `batchGeocode.js` are all `async`/`pg`-based now (not
  `better-sqlite3`) — every DB-touching function returns a Promise and
  every call site must `await` it.

# Workflow / repo etiquette
- Commits are small and single-purpose; imperative present tense, no
  trailing period. Bug-fix commits name the actual bug in the message
  (e.g. "Fix geocode always matching on zipl, even for even numbers"), not
  "fix bug".
- `geocoding-server`'s pool against `geocoding` is enforced read-only at
  the Postgres session level (`createReadOnlyPool` in `src/db.js`, via the
  `default_transaction_read_only` startup parameter) — never add a write
  path against it there (only `geocoding_users` is writable, via
  `src/users.js`). `test/readOnlyPool.test.js` guards this.
- Run the relevant test suite after touching `geocode.js`, `interpolate.py`,
  or `schema.py` — these three are the ones most likely to break silently.

# Environment / data layout
- Local Postgres 18 + PostGIS, peer-authenticated as the `my_ai` role (no
  password for local Unix-socket connections). `geocoding-server/src/db.js`
  and `geocoding-server/test/helpers.js` build connection strings as
  `postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/<db>` — the socket path
  must be percent-encoded into the URI's host component; `pg` only treats
  a Unix socket path as such from that form or a plain `host` config
  field, never from a bare connection-string host.
- `streets` has a native PostGIS `geom` column (SRID 4326, GiST index)
  alongside the plain-text WKT `geometry` column that
  `geocode.js`/`interpolate.py` actually use — populated directly at
  ingest time from the same WKT (`ST_GeomFromText`), so the database opens
  directly in QGIS as a vector layer with no separate conversion step
  (there's no SpatiaLite-style extension-loading workaround needed here).
- The original SQLite files (`geocoding.sqlite`, `users.sqlite`) and the
  raw TIGER/Line shapefiles live outside the repo and are gitignored;
  `geocoding/migrate_to_postgres.py` was the one-time script that copied
  their data into Postgres (~499K streets rows, ~475K street_names rows,
  Maine + NH).
- Server env vars (all optional): `GEOCODING_DSN` (default
  `postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding`), `USERS_DSN`
  (default `.../geocoding_users`), `PORT` (default 3001), `OFFSET_FEET`
  (default 20), `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` (unset =
  `billing.js`'s stub), `PAYPAL_API_BASE` (default
  `https://api-m.sandbox.paypal.com` -- set to `https://api-m.paypal.com`
  to go live).
- Frontend PayPal env vars, both optional and both default to sandbox:
  `VITE_PAYPAL_CLIENT_ID` (`ui/desktop`, e.g. via a gitignored
  `ui/desktop/.env.local`) / `EXPO_PUBLIC_PAYPAL_CLIENT_ID` (`ui/mobile`)
  set the Client ID the checkout page embeds; `VITE_PAYPAL_ENV` /
  `EXPO_PUBLIC_PAYPAL_ENV` set to `live` swaps the checkout page's
  sandbox-disclaimer copy for real-charge copy. These only change what
  the page *says* and which PayPal app it talks to -- keep them in sync
  with the server's own `PAYPAL_CLIENT_ID`/`PAYPAL_API_BASE`, which is
  what actually decides sandbox vs. live.
- `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`/`SES_FROM_EMAIL`
  (all optional -- unset = `emailDelivery.js`'s stub) email the service
  key after `/billing/purchase`, via AWS SES. Use an IAM user scoped to
  only `ses:SendEmail`; `SES_FROM_EMAIL` must be a verified identity, and
  while the SES account is in its sandbox, so must the recipient.
- `VITE_MOBILE_APP_URL` (`ui/desktop` only, optional, unset by default --
  no mobile deployment exists yet) -- when set, a mobile visitor to
  `ui/desktop` sees a banner prompting them to `ui/mobile` instead of the
  "install this as a PWA" banner (`Layout.tsx` renders at most one of
  `MobileRedirectBanner`/`InstallAppBanner`, never both -- see
  `deviceDetection.ts`'s `isMobileDevice`). Purely a dismissible prompt,
  never an automatic redirect.
- `OVERPASS_URL` (optional, default `https://overpass-api.de/api/interpreter`) --
  the public Overpass API instance `POST /places/search`
  (`geocoding-server/src/placesSearch.js`) queries for OpenStreetMap
  points-of-interest near a clicked map location, matched against a
  free-text query (`ui/desktop`'s Find Places page, `/find-places`).
  Free, no API key/billing, same "public data only" sourcing as
  everything else in this project -- but shared and genuinely rate-
  limited (2 concurrent request slots per IP; see
  `https://overpass-api.de/api/status`), so failures/timeouts/429s are
  expected in normal operation, not a sign of a bug -- they surface as
  `UpstreamError` -> HTTP 502, distinct from a real 500. Overpass
  requires both an explicit `Content-Type` header (Node's `fetch`,
  unlike a browser's, won't infer one for a plain string body -- omitting
  it gets a 406) and a real `User-Agent` identifying the client (Node's
  default fetch UA gets filtered by Overpass, also as a 406). The free
  instance load-balances across several backend mirrors of uneven,
  fluctuating load (the "Announced endpoint" in its own `/api/status`
  varies call to call), so a single attempt landing on a busy one can
  time out even when Overpass overall has capacity --
  `OVERPASS_MAX_ATTEMPTS` retries once on a timeout/5xx before giving
  up, but never retries a 429 (rate-limited), since hitting the same
  2-slot-per-IP limit again immediately would just make it worse.
  Results need `addr:housenumber` + `addr:street` + `addr:postcode` tags to
  produce a Meridian-geocodable address line (`addressLineFromTags`) --
  anything else is counted in `skipped`, not silently dropped. The page
  downloads matched addresses as a plain `.txt` list, one per line, ready
  to feed straight into Batch geocode -- this search itself does not use
  Meridian's own geocoding.
- `NOMINATIM_URL` (optional, default
  `https://nominatim.openstreetmap.org/search`) -- a second, different
  free/public OSM service `searchPlaces` calls only when the query
  includes a "near &lt;place&gt;" clause (`parseNearQuery`, e.g. "barber
  shop near Brunswick, Maine"), to resolve that place name to
  coordinates without requiring a map click first. Distinct from
  Overpass: Nominatim is a purpose-built place-name search index, not a
  spatial query language, and has its own stricter usage policy (max 1
  request/second, real `User-Agent` required -- fine here since it's one
  lookup per user-initiated search, never batched). Always takes
  priority over any explicit `latitude`/`longitude` also passed in, on
  the theory that what the user just typed is a stronger signal than a
  possibly-stale map click; without a "near" clause, `latitude`/
  `longitude` are still required same as before this existed. Throws
  `ValidationError` (the user's fault -- be more specific, or click the
  map) when nothing matches, `UpstreamError` for a Nominatim-side
  failure. The response's `center` field (only set when resolved this
  way) lets `FindPlaces.tsx` move the map/marker to reflect where the
  search actually landed.
- `FEEDBACK_NOTIFY_EMAIL` (optional -- unset = stub) is where `POST
  /feedback` emails you when a comment/question comes in; uses the same
  SES credentials above. The comment is saved in `geocoding_users`'
  `feedback` table either way (see `feedback.js`) -- there's no public
  listing or reply endpoint, reviewing/replying is manual (psql + email),
  same as `users.js`'s `upsertUser`.
- `ALLOW_TEST_EMPTY_SERVICE_KEY` (optional, default off) lets all three
  batch endpoints accept an empty `serviceKey` for any known email,
  purely to skip looking one up while testing (see `quota.js`'s
  `checkQuota`) -- a *wrong* key is still rejected either way. It also
  lets `/geocode/batch` and `/geocode/batch/download` accept no email at
  all, running as a pure smoke test with no account/quota touched (see
  the `emailProvided` checks in `server.js`); `/geocode/batch/email`
  still always requires a real email, since that's the address results
  actually get sent to. **Never set this anywhere real customers' quota
  is at stake**: there's no separate staging server in this setup, so if
  a box is also taking live payments, this must stay unset there. Logs a
  startup warning when enabled. Both apps' Batch screens have no
  client-side check that email/serviceKey are non-empty either --
  submitting blank just lets the server's response (success or a clear
  error) decide.

# Known gaps (don't assume these are done)
- `geocoding-server/src/emailDelivery.js`'s `sendResultsEmail` (the
  batch-results ZIP attachment) is a **deliberate stub** — logs and
  returns instead of sending; a real ZIP-by-email path needs a raw MIME
  message, not just the plain-text send `sendServiceKeyEmail` uses.
  `sendServiceKeyEmail` (the purchase service-key email) is wired up for
  real via AWS SES, falling back to the same stub pattern when SES env
  vars aren't set.
- No signup/login flow — `users.js`'s `upsertUser()` is a manual admin
  operation, and account creation itself (via `/billing/purchase` or
  `upsertUser`/`addToTier`) isn't authenticated. Batch geocoding itself
  *is* now gated: every account gets an opaque `service_key` (generated
  once, returned by `/billing/purchase`), and all three batch endpoints
  require it alongside the email (see `quota.js`'s `checkQuota`) — email
  alone is no longer enough to spend an account's quota. The read-only
  `GET /quota` status check still only takes an email, by design (it
  can't spend anything).
- `ui/mobile` has no server-URL abstraction yet — check the relevant
  component before assuming the API base URL is configurable.
- `ui/desktop`'s Import Addresses page (`/import-addresses`,
  `ImportAddresses.tsx`) turns a messy CSV/Excel export -- e.g. street
  number, street name, city, and state/ZIP each in their own column --
  into a clean address list ready for Batch geocode. Parsing (via
  SheetJS's `xlsx` package, installed from SheetJS's own CDN rather than
  the public npm registry, which has stopped receiving their security
  fixes -- see the `xlsx` entry in `package.json`) happens entirely in
  the browser; nothing is uploaded to the server. Column-role guesses
  (`guessRole`) are just a starting point the user confirms/fixes on the
  mapping step -- nothing here silently commits to a wrong guess. Rows
  are flagged, not dropped, when they can't produce a geocodable address
  line (same leading-house-number/trailing-5-digit-ZIP rule
  `parseAddress.js` enforces server-side, reimplemented client-side in
  `isGeocodableAddressLine` since this step never touches the server).
  The preview step's filter bar covers every column in the uploaded
  file, not just the ones mapped to an address role (e.g. a "Region" or
  "Notes" column someone didn't map to anything is still filterable) --
  a column only gets a dropdown if it has 2-50 distinct values
  (`filterableColumns`); the search box matches anywhere in the full
  generated address line, covering columns without their own dropdown.
  "Select all matching"/"Deselect all matching" act on every row
  matching the current filters, not just what's rendered -- for a file
  with thousands of rows, only a `SAMPLE_SIZE` (100) sample is actually
  rendered in the table to keep the page responsive, with a note telling
  the user it's a sample and that the count/bulk actions still cover the
  full matching set. "Send to Batch geocode" skips the download/re-
  upload round trip by navigating to `/batch` with the address list in
  router state (`navigate('/batch', { state: { fileContent, fileName }
  })`) -- `Batch.tsx`'s `pickedFile` reads that via a lazy `useState`
  initializer so it only applies on the navigation that carried it, not
  on every re-render or a later plain visit to `/batch`; a "Back to
  Import Addresses" `Link` appears on Batch when arrived this way (own
  `arrivedFromImport` flag, captured once, independent of `pickedFile`
  so clearing the file doesn't hide the way back). The whole wizard's
  state (`ImportAddressesState.tsx`'s `ImportAddressesStateProvider`,
  wrapped around `<Routes>` in `App.tsx`) lives above the route rather
  than as local state in `ImportAddresses.tsx`, so going to Batch and
  back preserves the file, mapping, filters, and row selection instead
  of resetting the wizard -- the point being a user comparing a few
  different filtered selections shouldn't have to redo the upload/
  mapping step each time.
- `ui/desktop` is a scaffold only (Vite + React + react-router, routes
  for every screen, `ui/shared`'s API client wired up and proven working
  against a live `geocoding-server`) — no real screen UI implemented yet.
- `ui/shared` holds API client/types/coordinate-parsing code used by both
  frontends. Deliberately excludes anything with maplibre-gl types (a
  separate install there is a nominally distinct type from each app's own
  copy to TypeScript) — map integration stays duplicated per-app unless
  npm workspaces get set up to hoist one shared install.
- `batchGeocode.js`'s `geocodeAddressList` runs one address at a time
  (not `Promise.all`'d) on purpose, to avoid exhausting the Postgres
  pool on a large batch — see the comment there. **Planned:** bounded
  concurrency (e.g. ~8 addresses in flight at once, under `pg`'s default
  pool size of 10) instead of strictly sequential, for a real speedup on
  large batches without that risk. Not done yet — don't assume batch
  requests are parallelized.
