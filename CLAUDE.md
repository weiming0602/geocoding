# geocoding

Custom address geocoding engine for Maine (+ NH) built on Census TIGER/Line
`edges` shapefiles, with an API server and a mobile/web app on top. No
third-party geocoding API is used — house-number interpolation is done
directly against ingested street centerline geometry.

**You are almost certainly on the `geocoding_batch` branch**, not `master`.
`master` only has the original Python scaffold; all server/app work and most
Python work landed on `geocoding_batch`. Check `git branch --show-current`
before assuming what exists.

## Layout (three sub-projects in one repo)

```
geocoding/            Python: ingest TIGER/Line shapefiles -> SQLite
geocoding-server/     Express API: geocode/reverse-geocode/batch, quota, email
geocoding-app/        Expo/React Native app: forms + maps calling the API
```

Data lives outside the repo (gitignored):
- `C:\software\database\original datafiles\` — raw TIGER/Line `.shp/.dbf/.shx/...`
  per Maine county (`tl_2024_23XXX_edges.*`), already downloaded for all 16
  Maine counties.
- `C:\software\database\sqlite3\geocoding.sqlite` — ingested `streets` table,
  already built statewide for Maine (~477MB). This is the DB the server reads.
- `C:\software\database\sqlite3\users.sqlite` — quota/subscription users table,
  created lazily by the server on first run.

## geocoding/ (Python ingest)

- `schema.py` — `streets` table DDL + indexes. Notably an expression index
  on `UPPER(fullname)` because `geocode.js` queries case-insensitively —
  without it SQLite can't use an index and batch geocoding is ~10x slower.
- `ingest.py` — reads one county `.shp`, keeps only road features (MTFCC
  starting with "S"), writes WKT geometry + bbox + address ranges. Keyed by
  `TLID` (nationwide-unique), so re-ingesting is idempotent (`INSERT OR
  IGNORE`).
- `update_state.py` — downloads (if not cached) and ingests every county's
  edges for a state. `STATES` registry (in `states.py`) currently has `ME`
  and `NH`. Idempotent, safe to re-run to pick up a new TIGER vintage.
- `update_state_names.py` — joins the national `tl_<year>_us_state` shapefile
  onto `streets` by `statefp` to fill `state`/`state_abbr` (needed because
  the server filters matches by state).
- `interpolate.py` — the actual math: given a WKT LINESTRING + an address
  range + a house number, finds the fractional point along the line and
  optionally offsets it perpendicular (in feet) to push the point off the
  centerline onto the correct side of the street. Odd numbers use the left
  range/offset left; even numbers use the right range/offset right — this
  convention is duplicated in `geocode.js`, keep both in sync if it changes.
- `tests/` has pytest coverage for `ingest.py`, `interpolate.py`,
  `update_state.py`, and `update_state_names.py` (25 tests, all passing).

Run: `cd geocoding && .venv\Scripts\python -m geocoding.update_state <db> --state ME`

## geocoding-server/ (Express API)

DB is opened **read-only**; nothing in the server ever writes to
`geocoding.sqlite` (only to `users.sqlite`).

Endpoints (`src/server.js`):
- `POST /geocode` — single address -> coordinates.
- `POST /geocode/batch` — reads a newline-delimited address file by path,
  returns per-line results.
- `POST /geocode/batch/download` — same, zipped as `results.csv` +
  `errors.csv`.
- `POST /geocode/batch/email` — same, gated by monthly quota
  (`src/quota.js`/`src/users.js`), then emailed.
- `POST /reverse-geocode` — coordinate -> nearest street address.

Matching logic (also documented in `geocoding-server/README.md`): parse
address into `{number, streetName, zip}` -> find candidate `streets` rows by
`fullname` (case-insensitive) + `zipl`/`zipr` + `state` -> interpolate the
first candidate whose range contains the number.

**Known gaps:**
- `src/emailDelivery.js` is a **deliberate stub** — logs and returns
  `{stubbed: true}` instead of sending. Every caller goes through this one
  function, so swapping in nodemailer/SES/SendGrid only requires editing this
  file.
- `src/users.js` has no signup flow — `upsertUser(db, email, tier)` is a
  manual admin operation. Requests aren't authenticated; any email string is
  accepted and looked up as-is. No payment integration.
- `package.json`'s `"test"` script is a placeholder stub — actually run
  tests with `node --test` (uses Node's built-in test runner directly), not
  `npm test`.

Run: `cd geocoding-server && npm install && node src/server.js`
Test: `cd geocoding-server && node --test` (71 tests, all passing on the
actual Windows dev machine).

Env vars (all optional): `GEOCODING_DB_PATH`, `USERS_DB_PATH`, `PORT`
(default 3001), `OFFSET_FEET` (default 20).

## geocoding-app/ (Expo/React Native)

Screens/components in `components/`: `GeocodeForm`, `BatchGeocodeForm`,
`ReverseGeocodeForm`, plus `.tsx`/`.web.tsx` map component pairs
(`GeocodeMap`, `BatchGeocodeMap`) — the `.web.tsx` variant is a
react-native-web-specific override, keep both in sync when changing map
behavior. Talks to `geocoding-server` over HTTP; no server URL abstraction
found yet, check components for the base URL before assuming it's
configurable.

Run: `cd geocoding-app && npm install && npm start`

## Conventions seen in history

- Commits are small and single-purpose (one bug fix or one feature per
  commit); commit messages are imperative, present tense, no period.
- Bug-fix commits explicitly name the bug in the message (e.g. "Fix geocode
  always matching on zipl, even for even (right-side) numbers") rather than
  vague messages like "fix bug".
- New DB columns require a matching entry in `schema.py`'s
  `_MIGRATED_COLUMNS` + `ensure_columns()` so already-populated databases get
  migrated, since `CREATE TABLE IF NOT EXISTS` is a no-op on existing tables.

## Plausible next steps (as of last review)

1. Wire up real email delivery (`emailDelivery.js`).
2. Build self-serve signup/auth/billing (currently admin-only user creation,
   no request auth).
3. Extend `STATES` beyond ME/NH if broader coverage is wanted.
