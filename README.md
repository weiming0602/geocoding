# geocoding

A custom address geocoding engine.

**Coverage: Maine and New Hampshire only, United States.** Built on Census
TIGER/Line data for those two states plus Maine's E911 address points (see
`geocoding/ingest_address_points.py`); no other US state or country is
covered.

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
- [ ] Street name normalization / matching

## Related projects (this repo)

- [`geocoding-server`](geocoding-server) — Express + `pg` API that
  parses a free-text address, matches it against `streets`, and interpolates
  coordinates (odd numbers → left range/offset, even → right range/offset)
- [`ui/mobile`](ui/mobile) — Expo/React Native app with a text input
  and "Geocode" button that calls `geocoding-server`
- [`ui/desktop`](ui/desktop) — React web app calling the same
  `geocoding-server` API
