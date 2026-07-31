# geocoding

A custom address geocoding engine.

## Step 1: ingest TIGER/Line street edges into SQLite

[US Census TIGER/Line edges](https://www.census.gov/geo/tiger) shapefiles
(`tl_<year>_<statecounty>_edges.shp`) carry per-side address ranges and ZIP
codes, which is what makes house-number interpolation possible later.

```bash
python -m geocoding.ingest path/to/tl_2023_06075_edges.shp data/streets.db
```

This creates (or appends to) a `streets` table in the given SQLite
database, storing each edge's geometry as WKT plus its address ranges,
ZIP codes, and bounding box for fast lookups.

## Setup

```bash
py -3 -m venv .venv
./.venv/Scripts/python.exe -m pip install -e ".[dev]"
./.venv/Scripts/python.exe -m pytest
```

## Step 2: interpolate a house number along a street segment

```bash
python -m geocoding.interpolate data/streets.db <street_id> <number> \
    --range-side left --offset-feet 5 --offset-side right
```

`--range-side` picks which address range to interpolate against
(`left` uses `lfromadd`/`ltoadd`, `right` uses `rfromadd`/`rtoadd`).
`--offset-feet`/`--offset-side` nudge the result perpendicular to the
line by a real-world distance, e.g. to move the point off the
centerline and onto the correct side of the street.

## Step 3: turn `streets` into a real spatial layer (SpatiaLite)

`streets.geometry` is plain WKT text — fine for `geocoding-server`'s own
math, but invisible to GIS tools. `add_geometry_column.py` adds a proper
SpatiaLite `geom` column (SRID 4326) plus an R-Tree spatial index, so the
database opens directly in QGIS (or any SpatiaLite client) as a `streets`
vector layer:

```bash
python -m geocoding.add_geometry_column C:\software\database\sqlite3\geocoding.sqlite
```

Requires `mod_spatialite` — the script points at the copy bundled with
QGIS (`C:\Program Files\QGIS <version>\bin`) by default; edit
`MOD_SPATIALITE_DIR` at the top of the script if yours lives elsewhere.
Safe to re-run after ingesting more data: it only backfills rows where
`geom IS NULL`, so already-converted rows aren't touched.

## Roadmap

- [x] Ingest TIGER/Line edges shapefiles into SQLite
- [x] Address-range interpolation to lat/lng, with perpendicular offset
- [x] Query interface that resolves a full address to coordinates (see `geocoding-server`)
- [x] Real spatial layer via SpatiaLite, for opening in QGIS
- [ ] Street name normalization / matching

## Related projects (this repo)

- [`geocoding-server`](geocoding-server) — Express + better-sqlite3 API that
  parses a free-text address, matches it against `streets`, and interpolates
  coordinates (odd numbers → left range/offset, even → right range/offset)
- [`geocoding-app`](geocoding-app) — Expo/React Native app with a text input
  and "Geocode" button that calls `geocoding-server`
