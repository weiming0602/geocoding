"""PostgreSQL/PostGIS schema for ingested TIGER/Line street edges.

Replaces the old SQLite + bolted-on SpatiaLite schema. `geom` is now a
native PostGIS geometry column (GiST-indexed), populated directly at
insert time from the same WKT this module's callers already compute --
no separate conversion pass needed (SpatiaLite's version needed one only
to work around SQLite's extension-loading quirks; that constraint
doesn't exist here). `geometry` (WKT text) is kept alongside it since
geocode.js/interpolate.py parse WKT directly with their own custom
interpolation math, never through PostGIS's ST_ functions.

Requires the `postgis` extension (CREATE EXTENSION IF NOT EXISTS postgis;
run once per database -- see the one-time setup in the migration docs).
Routing (see routing_topology.py) additionally requires `pgrouting`
(`sudo apt install postgresql-18-pgrouting`, then
CREATE EXTENSION IF NOT EXISTS pgrouting; -- also a one-time, manual step).
LLM-assisted geocoding's candidate-street lookup (see geocoding-server/src/
geocodeMatching.js's candidateStreetNames) additionally requires `pg_trgm`
(CREATE EXTENSION IF NOT EXISTS pg_trgm; -- same one-time, manual pattern).
"""

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS streets (
    id BIGSERIAL PRIMARY KEY,
    tlid TEXT,
    fullname TEXT,
    lfromadd TEXT,
    ltoadd TEXT,
    rfromadd TEXT,
    rtoadd TEXT,
    zipl TEXT,
    zipr TEXT,
    mtfcc TEXT,
    statefp TEXT,
    countyfp TEXT,
    state TEXT,
    state_abbr TEXT,
    geometry TEXT,
    minx DOUBLE PRECISION,
    miny DOUBLE PRECISION,
    maxx DOUBLE PRECISION,
    maxy DOUBLE PRECISION,
    -- Generic Geometry, not LineString: a shapefile edge can have multiple
    -- parts (ingest.py's _shape_to_wkt then emits MULTILINESTRING), which
    -- a LineString-typed column would reject outright.
    geom geometry(Geometry, 4326),
    -- TIGER/Line's own topology node IDs for this edge's two endpoints --
    -- real Census-computed intersection identifiers, not something we
    -- derive ourselves by snapping geometry endpoints. Present in the
    -- edges shapefile's own field list but unused until routing_topology.py
    -- needed real connectivity (nextCrossStreet.js/geocode.js only ever
    -- needed per-segment geometry, never graph structure).
    tnidf TEXT,
    tnidt TEXT
);
"""

# Adds tnidf/tnidt to a `streets` table created before this schema change --
# CREATE TABLE IF NOT EXISTS above only helps a brand-new database; this
# is the one-time migration for the ~499K rows already ingested. Safe to
# run unconditionally on either a new or an existing table (IF NOT EXISTS
# guards on both the table and per-column). Run once, manually.
ADD_ROUTING_COLUMNS_SQL = """
ALTER TABLE streets ADD COLUMN IF NOT EXISTS tnidf TEXT;
ALTER TABLE streets ADD COLUMN IF NOT EXISTS tnidt TEXT;
"""

CREATE_INDEXES_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_streets_tlid_unique ON streets (tlid);
CREATE INDEX IF NOT EXISTS idx_streets_fullname ON streets (fullname);
CREATE INDEX IF NOT EXISTS idx_streets_zip ON streets (zipl, zipr);
CREATE INDEX IF NOT EXISTS idx_streets_bbox ON streets (minx, miny, maxx, maxy);
CREATE INDEX IF NOT EXISTS idx_streets_state ON streets (state);
CREATE INDEX IF NOT EXISTS idx_streets_state_abbr ON streets (state_abbr);
CREATE INDEX IF NOT EXISTS idx_streets_fullname_zipl_zipr_state
    ON streets (fullname, zipl, zipr, state);
-- geocode.js's actual queries compare UPPER(fullname), which the plain
-- index above can't serve. Without this, Postgres falls back to
-- searching by zipl alone and filtering every row in that ZIP row-by-row
-- -- fine for a single request, ~10x slower at batch scale (measured on
-- 10k rows against the old SQLite schema; same index-shape reasoning
-- applies here).
-- (Superseded for name matching by street_names below, kept for streets
-- rows that predate street_names or any other direct-fullname query.)
CREATE INDEX IF NOT EXISTS idx_streets_fullname_upper_zip
    ON streets (UPPER(fullname), zipl, zipr, state, state_abbr);
CREATE INDEX IF NOT EXISTS idx_streets_fullname_upper_zipr
    ON streets (UPPER(fullname), zipr, zipl, state, state_abbr);
-- zipl-first (idx_streets_zip) only helps zipl-anchored lookups; even
-- house numbers query zipr, which without this falls back to a full
-- table scan (measured: ~300ms/miss vs ~3ms/miss with this in place).
CREATE INDEX IF NOT EXISTS idx_streets_zipr_zipl ON streets (zipr, zipl);
-- GiST index for `geom` -- not queried by geocode.js/reverseGeocode.js
-- today (they use the plain minx/miny/maxx/maxy bbox columns above), but
-- this is what makes the table a real spatial layer for QGIS/PostGIS
-- clients, and what any future ST_-function-based query would need.
CREATE INDEX IF NOT EXISTS idx_streets_geom ON streets USING GIST (geom);
"""

# A pgRouting-compatible edges view needs small sequential integer
# source/target ids, not TIGER's own (large, non-sequential) TNID text
# values -- this table is that id mapping, plus each node's real
# coordinate (an edge's start/end point) so a driver's/hazard's arbitrary
# lat/lon can snap to the nearest real intersection via a GiST KNN query.
# Populated by routing_topology.py's refresh_routing_topology, not at
# ingest time -- it's derived from streets, not sourced from TIGER
# directly.
CREATE_ROUTING_TOPOLOGY_NODES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS streets_topology_nodes (
    id SERIAL PRIMARY KEY,
    tnid TEXT UNIQUE NOT NULL,
    geom geometry(Point, 4326) NOT NULL
);
"""

CREATE_ROUTING_TOPOLOGY_NODES_INDEXES_SQL = """
CREATE INDEX IF NOT EXISTS idx_streets_topology_nodes_geom
    ON streets_topology_nodes USING GIST (geom);
"""

# pgr_dijkstra/pgr_ksp's edges-SQL parameter expects an (id, source,
# target, cost, reverse_cost) shape -- this view is that shape over our
# own streets + topology nodes, so no separate routing-only copy of street
# data needs to be maintained. cost/reverse_cost are real-world meters
# (ST_Length on the geography cast) in the source -> target and
# target -> source directions; -1 means "can't travel this way", which
# pgRouting's directed mode treats as no edge. TIGER itself has no
# one-way data at all, so direction comes from OpenStreetMap via
# street_oneway (see osm_oneway.py). A segment with no row there (no
# confident OSM match) is two-way -- except a limited-access highway or
# ramp (MTFCC S1100/S1630), which is closed in both directions instead:
# those are almost always one-way in reality, and routing the wrong way
# down one is the failure this exists to prevent. source/target follow the segment's own geometry
# (tnidf = start point, tnidt = end point), the same orientation
# street_oneway.direction is expressed in. Only edges with a resolved
# tnidf/tnidt qualify -- a street row ingested before that schema change
# (or never re-ingested since) doesn't participate in routing until
# backfilled.
#
# DROP + CREATE rather than CREATE OR REPLACE: Postgres can't add a
# column (reverse_cost) to an existing view in place.
CREATE_ROUTING_EDGES_VIEW_SQL = """
DROP VIEW IF EXISTS streets_routing_edges;
CREATE VIEW streets_routing_edges AS
SELECT
    s.id AS id,
    nf.id AS source,
    nt.id AS target,
    CASE WHEN o.direction = -1 OR (o.tlid IS NULL AND s.mtfcc IN ('S1100', 'S1630')) THEN -1
         ELSE ST_Length(s.geom::geography) END AS cost,
    CASE WHEN o.direction = 1 OR (o.tlid IS NULL AND s.mtfcc IN ('S1100', 'S1630')) THEN -1
         ELSE ST_Length(s.geom::geography) END AS reverse_cost,
    s.geom AS geom
FROM streets s
JOIN streets_topology_nodes nf ON nf.tnid = s.tnidf
JOIN streets_topology_nodes nt ON nt.tnid = s.tnidt
LEFT JOIN street_oneway o ON o.tlid = s.tlid
WHERE s.tnidf IS NOT NULL AND s.tnidt IS NOT NULL;
"""

CREATE_STREET_NAMES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS street_names (
    id BIGSERIAL PRIMARY KEY,
    tlid TEXT NOT NULL,
    fullname TEXT NOT NULL,
    paflag TEXT,
    zipl TEXT,
    zipr TEXT,
    state TEXT,
    state_abbr TEXT
);
"""

CREATE_STREET_NAMES_INDEXES_SQL = """
-- Same (tlid, fullname) row can appear once per county file at most, but
-- re-ingesting (idempotency) relies on this to dedupe via
-- INSERT ... ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_street_names_tlid_fullname_unique
    ON street_names (tlid, fullname);
CREATE INDEX IF NOT EXISTS idx_street_names_tlid ON street_names (tlid);
-- zipl/zipr/state/state_abbr are denormalized copies from the matching
-- streets row (see sync_street_names_zip_state in ingest_featnames.py).
-- This is deliberate, not an oversight: geocode.js needs to filter by
-- name+zip+state together, and a runtime JOIN back to streets for that
-- filtering step measured ~15x slower at batch scale than querying one
-- table directly (nested-loop cost of a nested lookup per zip-matched
-- row, versus streets' original single-table design). These composite
-- expression indexes mirror streets' idx_streets_fullname_upper_zip(r)
-- exactly, for the same reason: geocode.js compares UPPER(fullname).
CREATE INDEX IF NOT EXISTS idx_street_names_upper_fullname_zipl
    ON street_names (UPPER(fullname), zipl, zipr, state, state_abbr);
CREATE INDEX IF NOT EXISTS idx_street_names_upper_fullname_zipr
    ON street_names (UPPER(fullname), zipr, zipl, state, state_abbr);
-- The two indexes above lead with UPPER(fullname), which is useless for
-- geocode.js's LIKE '%...%' fallback (leading wildcard can't seek an
-- index). Without a zip-led index, an unmatched/misspelled street name
-- forces a full table scan of street_names on every fallback query.
-- These mirror streets' idx_streets_zip / idx_streets_zipr_zipl so the
-- fallback can filter down to just that ZIP's rows first, same as it did
-- before street_names existed.
CREATE INDEX IF NOT EXISTS idx_street_names_zipl_zipr ON street_names (zipl, zipr);
CREATE INDEX IF NOT EXISTS idx_street_names_zipr_zipl ON street_names (zipr, zipl);
"""

# Prototype: real per-house locations (Maine E911 address points), keyed
# by exact house number + street + town, not a range to interpolate
# along. Where a point exists, geocode.js uses it directly instead of
# range-interpolation -- range interpolation assumes addresses are evenly
# spaced along a segment, which is often wrong on long rural roads with
# a handful of widely-spaced houses (the whole reason this table exists).
# Unlike streets/street_names, this is state-specific data (source: Maine
# Office of GIS's E911 address points; no equivalent public NH dataset
# was found), so it carries its own state_abbr rather than assuming ME.
CREATE_ADDRESS_POINTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS address_points (
    id BIGSERIAL PRIMARY KEY,
    site_uid TEXT NOT NULL,
    address_number INTEGER,
    street_fullname TEXT,
    town TEXT,
    county TEXT,
    state_abbr TEXT,
    geom geometry(Point, 4326)
);
"""

CREATE_ADDRESS_POINTS_INDEXES_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_address_points_site_uid_unique ON address_points (site_uid);
-- Matches geocode.js's lookup key: exact house number + UPPER(street name)
-- + town, scoped to a state. Town-led (not number-led) since a caller
-- always has a state/town but ADDRESS_NUMBER alone is nowhere near
-- selective enough to lead an index.
CREATE INDEX IF NOT EXISTS idx_address_points_town_upper_street_number
    ON address_points (UPPER(town), UPPER(street_fullname), address_number, state_abbr);
-- Fallback for addresses with no parsed town (see parseAddress.js):
-- state-wide match on street name + number alone.
CREATE INDEX IF NOT EXISTS idx_address_points_upper_street_number
    ON address_points (UPPER(street_fullname), address_number, state_abbr);
CREATE INDEX IF NOT EXISTS idx_address_points_geom ON address_points USING GIST (geom);
"""
