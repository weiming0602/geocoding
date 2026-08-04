# geocoding

Custom address geocoding engine for Maine (+ NH) built on Census TIGER/Line
`edges` shapefiles — no third-party geocoding API. Sub-projects in one
repo: `geocoding/` (Python: shapefile → Postgres/PostGIS ingest +
interpolation), `geocoding-server/` (Express API), `ui/mobile/`
(Expo/React Native app), `ui/desktop/` (React web app).
`geocoding-server/README.md` documents the matching/interpolation
algorithm in detail — read that before touching `geocode.js` or
`interpolate.py`. Two Postgres databases: `geocoding` (streets/
street_names, read-only from the server) and `geocoding_users`
(subscriptions/quota, read-write).

# Bash commands
- Python: `.venv\Scripts\python -m geocoding.update_state "dbname=geocoding" --state ME`
  (venv is Windows-style `Scripts\`, not `bin/`; DSN is a psycopg
  connection string, e.g. `dbname=geocoding user=my_ai`)
- Python tests: `.venv\Scripts\python -m pytest` (32 tests in `tests/`) —
  each test creates and drops its own throwaway Postgres database (see
  `tests/conftest.py`'s `dsn` fixture)
- Server: `cd geocoding-server && node src/server.js`
- Server tests: `cd geocoding-server && node --test` — **not** `npm test`,
  that script is a placeholder stub. 93 tests, same throwaway-database-
  per-test pattern (see `test/helpers.js`).
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
  (default 20).

# Known gaps (don't assume these are done)
- `geocoding-server/src/emailDelivery.js` is a **deliberate stub** — logs
  and returns instead of sending. Every caller goes through this one
  function, so a real provider only needs to change this file.
- No signup/auth/billing — `users.js`'s `upsertUser()` is a manual admin
  operation; requests aren't authenticated.
- `ui/mobile` has no server-URL abstraction yet — check the relevant
  component before assuming the API base URL is configurable.
- `ui/desktop` is a scaffold only (Vite + React + react-router, routes
  for every screen, `ui/shared`'s API client wired up and proven working
  against a live `geocoding-server`) — no real screen UI implemented yet.
- `ui/shared` holds API client/types/coordinate-parsing code used by both
  frontends. Deliberately excludes anything with maplibre-gl types (a
  separate install there is a nominally distinct type from each app's own
  copy to TypeScript) — map integration stays duplicated per-app unless
  npm workspaces get set up to hoist one shared install.
