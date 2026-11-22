# Meridian Geocoding

An address geocoding platform for Maine and New Hampshire, built from public
data (Census TIGER/Line streets, Maine E911 address points) with **no
third-party geocoding API**. It is deployed as a web service with paid tiers at
[meridiangeocoding.com](https://www.meridiangeocoding.com), with web and
mobile apps, a road-hazard alerting product, and an ongoing machine-learning
experiment that matches house numbers to actual buildings.

## Highlights

- **Geocoding engine** — Python ingest of TIGER/Line edges and Maine E911
  address points into PostgreSQL/PostGIS; street-name normalization and
  matching; address-range interpolation with side-of-street offsets (side
  taken from each segment's own ranges — TIGER has no fixed odd/even side);
  the town an address names beats its ZIP (TIGER county subdivisions).
- **REST API** ([`geocoding-server`](geocoding-server), Express + `pg`) —
  forward and reverse geocoding, batch geocoding (CSV in, ZIP out),
  free-text place search (OpenStreetMap Nominatim/Overpass), quota-metered
  service keys, Stripe checkout with webhook fulfillment, per-IP rate
  limiting, and an LLM-assisted retry (Claude, forced tool-use choosing only
  among real street names) for addresses that fail to match.
- **Road Alerts** — live hazards from New England 511 and HERE Traffic
  matched to a driver's position, background Web Push alerts with a small
  sketch map, and reroutes around a hazard computed in-house with
  **pgRouting** on TIGER streets made one-way-aware from OpenStreetMap data.
- **Machine learning: which building is this address?**
  ([`address_inference`](address_inference)) — FEMA/ORNL building
  footprints, tax-parcel geometry, NAIP imagery (driveways, canopy) and
  USGS 3DEP lidar (roof size/height) feed a **LightGBM learning-to-rank**
  model trained on E911 points, followed by an in-order "road order"
  assignment along each street. Freeport, ME: within 50 m of the true
  building rose from 24.5% (range interpolation) to 46.6% with the ranker
  alone, then higher with road order; an owner-only map in the web app
  reviews every pick.
- **Apps** — React + TypeScript web app ([`ui/desktop`](ui/desktop),
  installable PWA, two sites from one build) and an Expo/React Native app
  ([`ui/mobile`](ui/mobile)), sharing API/types code in
  [`ui/shared`](ui/shared).
- **Operations** — deployed on DigitalOcean (droplets behind nginx +
  Let's Encrypt, static site on App Platform), systemd services and timers
  for annual data refresh, backups and digests ([`ops/`](ops)), GitHub
  Actions CI, and Python/Node/Vitest test suites that each create and drop
  their own throwaway Postgres database.

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, request flow, deployment |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Postgres/PostGIS schema |
| [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) | How the project was planned and built |
| [docs/ROAD_ALERTS_DESIGN.md](docs/ROAD_ALERTS_DESIGN.md) | Road Alerts design |
| [DATA_SOURCES.md](DATA_SOURCES.md) | Where the data comes from, licensing, refresh |
| [geocoding-server/README.md](geocoding-server/README.md) | Matching and interpolation algorithm in detail |
| [docs/README.md](docs/README.md) | Index of the reference docs |

**Coverage: Maine and New Hampshire only, United States.** Built on Census
TIGER/Line data for those two states plus Maine's E911 address points (see
`geocoding/ingest_address_points.py`); no other US state or country is
covered.

The sections below are the original step-by-step notes for the core Python
geocoding package.

## Step 1: ingest TIGER/Line street edges into Postgres

[US Census TIGER/Line edges](https://www.census.gov/geo/tiger) shapefiles
(`tl_<year>_<statecounty>_edges.shp`) carry per-side address ranges and ZIP
codes, which is what makes house-number interpolation possible later.

```bash
python -m geocoding.ingest path/to/tl_2023_06075_edges.shp "dbname=geocoding"
```

This creates (or appends to) a `streets` table in the given Postgres
database, storing each edge's geometry as WKT plus its address ranges,
ZIP codes, and bounding box for fast lookups -- and populates a native
PostGIS `geom` column from that same WKT, so the database is a real
spatial layer (see Step 3) with no separate conversion step.

## Setup

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -e ".[dev]"
./.venv/bin/python -m pytest
```

Requires a local Postgres with the `postgis` extension available, and a
role that can connect without a password over the Unix socket (peer
authentication) -- the test suite creates and drops its own throwaway
database per test (see `tests/conftest.py`).

## Step 2: interpolate a house number along a street segment

```bash
python -m geocoding.interpolate "dbname=geocoding" <street_id> <number> \
    --range-side left --offset-feet 5 --offset-side right
```

`--range-side` picks which address range to interpolate against
(`left` uses `lfromadd`/`ltoadd`, `right` uses `rfromadd`/`rtoadd`).
`--offset-feet`/`--offset-side` nudge the result perpendicular to the
line by a real-world distance, e.g. to move the point off the
centerline and onto the correct side of the street.

## Step 3: `streets` is already a real spatial layer (PostGIS)

`streets.geometry` is plain WKT text -- what `geocoding-server`'s own
interpolation math actually parses -- but `streets.geom` (a native
PostGIS `geometry(Geometry, 4326)` column, GiST-indexed) is populated
alongside it at ingest time via `ST_GeomFromText`, so the database opens
directly in QGIS (or any PostGIS client) as a `streets` vector layer with
no separate conversion pass needed.

## Roadmap

- [x] Ingest TIGER/Line edges shapefiles into Postgres
- [x] Address-range interpolation to lat/lng, with perpendicular offset
- [x] Query interface that resolves a full address to coordinates (see `geocoding-server`)
- [x] Real spatial layer via PostGIS, for opening in QGIS
- [x] Street name normalization / matching
- [x] Maine E911 address points; town-boundary matching (town beats ZIP)
- [x] REST API: forward/reverse/batch geocoding, service keys, quota, Stripe billing
- [x] LLM-assisted retry for addresses that fail to match
- [x] Road Alerts: 511/HERE hazards, Web Push, pgRouting reroutes (OSM one-way data)
- [x] ML building-address matching (footprints, parcels, imagery, lidar, LightGBM)
- [ ] Building outlines for houses missing from the footprint data (lake camps,
      tree-covered homes) and a TIGER address-range repair stage

## Related projects (this repo)

- [`geocoding-server`](geocoding-server) — Express + `pg` API that
  parses a free-text address, matches it against `streets` (and Maine E911
  points), and interpolates coordinates on the side whose own range holds
  the number
- [`ui/mobile`](ui/mobile) — Expo/React Native app with a text input
  and "Geocode" button that calls `geocoding-server`
- [`ui/desktop`](ui/desktop) — React web app calling the same
  `geocoding-server` API
