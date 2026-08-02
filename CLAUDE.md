# geocoding

Custom address geocoding engine for Maine (+ NH) built on Census TIGER/Line
`edges` shapefiles — no third-party geocoding API. Sub-projects in one
repo: `geocoding/` (Python: shapefile → SQLite ingest + interpolation),
`geocoding-server/` (Express API), `ui/mobile/` (Expo/React Native app),
`ui/desktop/` (React web app). `geocoding-server/README.md` documents the
matching/interpolation algorithm in detail — read that before touching
`geocode.js` or `interpolate.py`.

# Bash commands
- Python: `.venv\Scripts\python -m geocoding.update_state <db> --state ME`
  (venv is Windows-style `Scripts\`, not `bin/`)
- Python tests: `.venv\Scripts\python -m pytest` (25 tests in `tests/`)
- Rebuild the SpatiaLite `geom` column after ingesting new data:
  `.venv\Scripts\python -m geocoding.add_geometry_column <db>` (safe to
  re-run; only backfills rows where `geom IS NULL`)
- Server: `cd geocoding-server && node src/server.js`
- Server tests: `cd geocoding-server && node --test` — **not** `npm test`,
  that script is a placeholder stub. 71 tests.
- Mobile app: `cd ui/mobile && npm start`
- Desktop app: `cd ui/desktop && npm run dev`

# Code style
- Odd/even house-number convention (odd → left range/offset left, even →
  right range/offset right) is implemented independently in both
  `geocoding/interpolate.py` and `geocoding-server/src/geocode.js`. If you
  change the rule, change it in both places.
- New `streets` columns need an entry in `schema.py`'s `_MIGRATED_COLUMNS` +
  `ensure_columns()` — `CREATE TABLE IF NOT EXISTS` is a no-op against an
  existing table, so this is the only way already-populated databases pick
  up the column.
- `geocode.js` queries `UPPER(fullname)`; there's a matching expression
  index in `schema.py`. Don't drop or rename either without checking the
  other — without the index, batch geocoding is ~10x slower.

# Workflow / repo etiquette
- Commits are small and single-purpose; imperative present tense, no
  trailing period. Bug-fix commits name the actual bug in the message
  (e.g. "Fix geocode always matching on zipl, even for even numbers"), not
  "fix bug".
- `geocoding-server`'s DB connection is opened **read-only**; never add a
  write path against `geocoding.sqlite` there (only `users.sqlite` is
  writable, via `src/users.js`).
- Run the relevant test suite after touching `geocode.js`, `interpolate.py`,
  or `schema.py` — these three are the ones most likely to break silently.

# Environment / data layout
- `geocoding.sqlite` and `users.sqlite` (`C:\software\database\sqlite3\`)
  and the raw TIGER/Line shapefiles (`C:\software\database\original
  datafiles\`) live outside the repo and are gitignored. `geocoding.sqlite`
  is built statewide for both Maine and NH (~499K rows total, ~456MB).
- `streets` also has a SpatiaLite `geom` column (SRID 4326, LINESTRING,
  R-Tree spatial index) alongside the plain-text WKT `geometry` column that
  `geocode.js`/`interpolate.py` actually use — added so the database opens
  directly in QGIS as a vector layer. Requires `mod_spatialite`; the
  conversion script points at the copy bundled with QGIS by default. A
  pre-conversion backup lives alongside it as
  `geocoding.sqlite.bak-pre-spatialite` (outside the repo, like the DB
  itself) — safe to delete once you've confirmed everything's fine.
- Server env vars (all optional): `GEOCODING_DB_PATH`, `USERS_DB_PATH`,
  `PORT` (default 3001), `OFFSET_FEET` (default 20).

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
