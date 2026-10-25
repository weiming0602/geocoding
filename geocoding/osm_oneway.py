"""Copies OpenStreetMap one-way restrictions onto TIGER street segments.

TIGER/Line has no one-way/direction data at all, so Road Alerts' routes
(roadReroute.js, testDriveRoute.js) used to treat every street as
two-way -- and could advise a detour the wrong way down a one-way street.
OSM does carry it (`oneway`, roundabouts, motorways), so this:

  1. downloads Geofabrik's per-state OSM extracts (.osm.pbf),
  2. loads every drivable OSM way into `osm_ways` (load_osm_ways),
  3. matches each routable TIGER segment to the OSM way that overlaps it
     most, and records the OSM way's direction -- relative to the TIGER
     segment's own tnidf -> tnidt orientation -- in `street_oneway`
     (refresh_street_oneway).

The routing graph stays TIGER (streets_routing_edges); street_oneway only
supplies its cost/reverse_cost. A segment with no confident OSM match has
no row: an ordinary street then stays two-way (OSM says ~98.5% of local
streets are), but a limited-access highway or ramp (TIGER S1100/S1630,
almost always one-way in reality) is closed to routing instead -- a route
that can't use a highway segment of unknown direction is a far better
failure than one that drives the wrong way down it. Confident two-way
matches are stored too (direction 0), so a highway segment OSM says IS
two-way stays usable.

Licensing: OSM data is ODbL. street_oneway is a derived database, kept in
its own table and used ONLY for routing -- never by geocoding (geocode.js,
reverseGeocode.js, interpolate.py), so geocoding results stay free of
ODbL terms. See DATA_SOURCES.md for the attribution and share-alike
obligations this carries.

Matching rules (measured on Portland/Brunswick/Farmington samples before
this was built: 83-94% of TIGER segments matched, ~2m median offset,
~91% name agreement once suffixes are normalized):
  - an OSM way within MATCH_DISTANCE_M must cover >= MIN_OVERLAP of the
    TIGER segment's length, and it must be the best-covering way of ALL
    drivable ways (two-way included), so a two-way street can't pick up
    a parallel one-way ramp;
  - names must agree after normalization, unless one side is unnamed
    (ramps usually are), in which case the stricter MIN_OVERLAP_UNNAMED
    and MIN_LENGTH_UNNAMED_M apply -- short unnamed segments were where
    the sample's mismatches came from.

Run (also wired into annual_update.py):
    python -m geocoding.osm_oneway "dbname=geocoding" --states ME NH
"""

import argparse
import sys
import urllib.request
from datetime import date
from pathlib import Path

import psycopg

from .states import STATES

GEOFABRIK_BASE = "https://download.geofabrik.de/north-america/us"

# OSM `highway` values a car can drive on. Service roads are included
# (TIGER's S1740 private/service roads match some of them) but driveways,
# parking aisles and drive-throughs aren't -- TIGER essentially never has
# those, and they'd only add wrong-match candidates.
DRIVABLE_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service",
}
EXCLUDED_SERVICE = {"driveway", "parking_aisle", "drive-through"}

MATCH_DISTANCE_M = 15
MIN_OVERLAP = 0.8
MIN_OVERLAP_UNNAMED = 0.9
MIN_LENGTH_UNNAMED_M = 20
# Matching is done in meters, in one fixed projection for the whole
# graph: UTM 19N covers all of Maine and most of NH; NH's zone-18 sliver
# distorts by far less than MATCH_DISTANCE_M.
MATCH_SRID = 26919


def oneway_direction(tags) -> int:
    """1 = travel only in the way's drawn direction, -1 = only against it,
    0 = both directions. Follows OSM's tagging conventions: an explicit
    `oneway` wins; otherwise roundabouts and motorways are implicitly
    one-way. `oneway=reversible`/`alternating` (direction changes by time
    of day) is treated as two-way: there's no single direction to commit
    to, and routing would otherwise drop the road entirely."""
    oneway = (tags.get("oneway") or "").strip().lower()
    if oneway in ("yes", "true", "1"):
        return 1
    if oneway in ("-1", "reverse"):
        return -1
    if oneway in ("no", "false", "0", "reversible", "alternating"):
        return 0
    if tags.get("junction") in ("roundabout", "circular"):
        return 1
    if tags.get("highway") in ("motorway", "motorway_link"):
        return 1
    return 0


def is_drivable(tags) -> bool:
    if tags.get("highway") not in DRIVABLE_HIGHWAYS:
        return False
    if tags.get("area") == "yes":
        return False
    if tags.get("highway") == "service" and tags.get("service") in EXCLUDED_SERVICE:
        return False
    return tags.get("access") not in ("private", "no")


def extract_url(state_abbr: str) -> str:
    """Geofabrik's daily extract for a state, e.g. .../us/new-hampshire-latest.osm.pbf."""
    slug = STATES[state_abbr]["name"].lower().replace(" ", "-")
    return f"{GEOFABRIK_BASE}/{slug}-latest.osm.pbf"


def download_extract(state_abbr: str, data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    url = extract_url(state_abbr)
    target = data_dir / url.rsplit("/", 1)[1]
    request = urllib.request.Request(url, headers={"User-Agent": "meridian-geocoding-osm-oneway/1.0"})
    with urllib.request.urlopen(request, timeout=300) as response, open(target, "wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)
    return target


def read_drivable_ways(path):
    """Yields (osm_id, highway, name, ref, oneway, wkt) for every drivable
    way in an .osm.pbf/.osm file. Imported lazily so the rest of this
    module (and the tests of its SQL) don't need pyosmium installed."""
    import osmium

    for way in osmium.FileProcessor(str(path)).with_locations().with_filter(osmium.filter.KeyFilter("highway")):
        if not way.is_way():  # nodes/relations can carry a highway tag too
            continue
        tags = {tag.k: tag.v for tag in way.tags}
        if not is_drivable(tags):
            continue
        coords = [(node.lon, node.lat) for node in way.nodes if node.location.valid()]
        if len(coords) < 2:
            continue
        wkt = "LINESTRING(" + ",".join(f"{lon} {lat}" for lon, lat in coords) + ")"
        yield way.id, tags["highway"], tags.get("name"), tags.get("ref"), oneway_direction(tags), wkt


CREATE_OSM_WAYS_SQL = f"""
CREATE TABLE IF NOT EXISTS osm_ways (
    osm_id BIGINT NOT NULL,
    highway TEXT NOT NULL,
    name TEXT,
    ref TEXT,
    oneway SMALLINT NOT NULL,
    geom geometry(LineString, 4326) NOT NULL,
    g geometry(LineString, {MATCH_SRID}),
    buffer geometry(Geometry, {MATCH_SRID})
);
"""

# Kept separate from streets (never an extra column on it) so nothing in
# the geocoding path can read OSM-derived data by accident -- see the
# module docstring. One row per TIGER segment with a confident OSM match.
# direction is relative to the TIGER segment's own geometry, which runs
# tnidf -> tnidt (= source -> target in streets_routing_edges): 1 = only
# source -> target, -1 = only target -> source, 0 = OSM confirms both
# directions.
CREATE_STREET_ONEWAY_SQL = """
CREATE TABLE IF NOT EXISTS street_oneway (
    tlid TEXT PRIMARY KEY,
    direction SMALLINT NOT NULL CHECK (direction IN (1, 0, -1)),
    osm_id BIGINT NOT NULL,
    overlap REAL NOT NULL
);
-- Tables created before direction 0 existed only allowed (1, -1).
ALTER TABLE street_oneway DROP CONSTRAINT IF EXISTS street_oneway_direction_check;
ALTER TABLE street_oneway ADD CONSTRAINT street_oneway_direction_check CHECK (direction IN (1, 0, -1));
"""


def load_osm_ways(dsn: str, paths) -> int:
    """Replaces osm_ways with every drivable way from `paths`. Returns the row count."""
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_OSM_WAYS_SQL)
        conn.execute("TRUNCATE osm_ways")
        count = 0
        with conn.cursor() as cur:
            with cur.copy("COPY osm_ways (osm_id, highway, name, ref, oneway, geom) FROM STDIN") as copy:
                for path in paths:
                    for osm_id, highway, name, ref, oneway, wkt in read_drivable_ways(path):
                        copy.write_row((osm_id, highway, name, ref, oneway, f"SRID=4326;{wkt}"))
                        count += 1
        prepare_osm_ways(conn)
        conn.commit()
    return count


def prepare_osm_ways(conn) -> None:
    """Fills the projected geometry/buffer columns matching uses, and indexes them."""
    conn.execute(f"UPDATE osm_ways SET g = ST_Transform(geom, {MATCH_SRID})")
    conn.execute(f"UPDATE osm_ways SET buffer = ST_Buffer(g, {MATCH_DISTANCE_M})")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_osm_ways_g ON osm_ways USING GIST (g)")
    conn.execute("ANALYZE osm_ways")


# Street-name normalization for comparing TIGER and OSM names. Lowercase,
# route numbers to one canonical form ("I- 295"/"Interstate 295" -> i295,
# "US Hwy 1"/"US 1" -> us1, "State Rte 101"/"NH 101"/"ME 9" -> rt101/rt9),
# common street-type words dropped ("Grove St" == "Grove Street",
# "Spaulding Tpke" == "Spaulding Turnpike"), then letters/digits only.
NORMALIZE_NAME_FUNCTION_SQL = r"""
CREATE OR REPLACE FUNCTION pg_temp.norm_street_name(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           lower(coalesce(t, '')),
         '\m(interstate|i)\s*-?\s*(\d+)', 'i\2', 'g'),
         '\mus\s*(hwy|highway|route|rte)?\s*(\d+)', 'us\2', 'g'),
         '\m(state\s*(rte|route|hwy|highway)|rte|route|me|nh|vt|ma|sr)\s*-?\s*(\d+)', 'rt\3', 'g'),
         '\m(street|st|avenue|ave|road|rd|drive|dr|lane|ln|place|pl|court|ct|boulevard|blvd|highway|hwy|terrace|ter|parkway|pkwy|bridge|brg|way|circle|cir|extension|ext|exd|turnpike|tpke|expressway|expy|bypass|byp|crossing|xing|square|sq|trail|trl|connector|conn)\M', '', 'g'),
         '[^a-z0-9]', '', 'g')
$$;
"""

# Matching, in steps:
#   tiger_m      routable TIGER segments, projected to meters
#   tiger_keys   every normalized name a segment is known by: its primary
#                fullname plus TIGER's alternates in street_names (e.g.
#                "Leeman Hwy" is also "US Hwy 1")
#   pairs        each (segment, OSM way) within the corridor: how much of
#                the segment the way covers, the way's direction relative
#                to the segment (+1/-1, 0 = two-way), and its road key
#                (name, else first ref) -- OSM splits one road into many
#                ways (at bridges, lane changes), so coverage is summed
#                over all ways of the same road in the same direction
#   groups       that sum per (segment, road key, direction), plus whether
#                any of the road's names/refs match one of the segment's
#   best_match   the best group per segment: enough coverage first, then
#                agreeing names, then the CLOSEST road, then more
#                coverage, then two-way over one-way on a tie (missing a
#                restriction is safer than inventing one). Closest before
#                coverage matters on divided highways: OSM draws each
#                direction as its own one-way way, sometimes only ~10 m
#                apart, so both carriageways can fully cover a TIGER line
#                -- the nearer one is the same carriageway; the other runs
#                the opposite way. (Before this ordering, ~7% of Maine/NH
#                interstate segments took the far carriageway's direction.)
MATCH_SQL = f"""
CREATE TEMP TABLE tiger_m ON COMMIT DROP AS
SELECT tlid, fullname, mtfcc, ST_Transform(geom, {MATCH_SRID}) AS g
FROM streets
WHERE tnidf IS NOT NULL AND tnidt IS NOT NULL AND GeometryType(geom) = 'LINESTRING';
CREATE INDEX ON tiger_m (tlid);

CREATE TEMP TABLE tiger_keys ON COMMIT DROP AS
SELECT DISTINCT tlid, key FROM (
    SELECT tlid, pg_temp.norm_street_name(fullname) AS key FROM tiger_m
    UNION ALL
    SELECT sn.tlid, pg_temp.norm_street_name(sn.fullname) FROM street_names sn
    JOIN tiger_m USING (tlid)
) k WHERE key <> '';
CREATE INDEX ON tiger_keys (tlid, key);

CREATE TEMP TABLE pairs ON COMMIT DROP AS
SELECT t.tlid, ST_Length(t.g) AS len, t.mtfcc, o.osm_id, o.highway,
    ST_Length(ST_Intersection(t.g, o.buffer)) AS covered,
    ST_Distance(ST_LineInterpolatePoint(t.g, 0.5), o.g) AS mid_dist,
    o.oneway * CASE WHEN ST_LineLocatePoint(o.g, ST_StartPoint(t.g)) < ST_LineLocatePoint(o.g, ST_EndPoint(t.g))
                    THEN 1 ELSE -1 END AS direction,
    coalesce(pg_temp.norm_street_name(o.name), '') AS osm_name_key,
    ARRAY(SELECT pg_temp.norm_street_name(r) FROM unnest(string_to_array(coalesce(o.ref, ''), ';')) AS r
          WHERE pg_temp.norm_street_name(r) <> '') AS osm_ref_keys,
    COALESCE(NULLIF(pg_temp.norm_street_name(o.name), ''),
             pg_temp.norm_street_name(split_part(coalesce(o.ref, ''), ';', 1))) AS road_key
FROM tiger_m t
JOIN osm_ways o ON ST_DWithin(t.g, o.g, {MATCH_DISTANCE_M});

CREATE TEMP TABLE groups ON COMMIT DROP AS
SELECT p.tlid, p.len, p.mtfcc, p.road_key, p.direction,
    LEAST(sum(p.covered) / NULLIF(p.len, 0), 1.0) AS overlap,
    min(p.mid_dist) AS dist,
    (array_agg(p.osm_id ORDER BY p.mid_dist, p.osm_id))[1] AS osm_id,
    bool_or(EXISTS (SELECT 1 FROM tiger_keys k
                    WHERE k.tlid = p.tlid AND (k.key = p.osm_name_key OR k.key = ANY (p.osm_ref_keys)))) AS names_agree,
    EXISTS (SELECT 1 FROM tiger_keys k WHERE k.tlid = p.tlid) AS tiger_named,
    bool_and(p.road_key = '') AS osm_unnamed,
    bool_or(p.highway LIKE '%%_link' OR p.highway = 'motorway') AS osm_ramp_or_motorway
FROM pairs p
GROUP BY p.tlid, p.len, p.mtfcc, p.road_key, p.direction;

CREATE TEMP TABLE best_match ON COMMIT DROP AS
SELECT DISTINCT ON (tlid) *
FROM groups
ORDER BY tlid, (overlap >= {MIN_OVERLAP}) DESC, names_agree DESC, dist, overlap DESC, abs(direction), osm_id;

TRUNCATE street_oneway;

INSERT INTO street_oneway (tlid, direction, osm_id, overlap)
SELECT tlid, direction, osm_id, overlap
FROM best_match
WHERE (
    -- names agree (any TIGER name vs. OSM name or any route ref)
    (names_agree AND overlap >= {MIN_OVERLAP})
    OR
    -- one side unnamed (typical of ramps): stricter geometry instead...
    ((NOT tiger_named OR osm_unnamed) AND overlap >= {MIN_OVERLAP_UNNAMED}
     AND (len >= {MIN_LENGTH_UNNAMED_M}
          -- ...except a TIGER ramp lying on an OSM ramp/motorway: the road
          -- types agree, so a short piece of ramp is still trustworthy
          OR (mtfcc = 'S1630' AND osm_ramp_or_motorway)))
  );
"""


def refresh_street_oneway(dsn: str) -> int:
    """Re-matches every routable TIGER segment against osm_ways and
    replaces street_oneway in one transaction (a failure leaves the
    previous table intact). Returns how many segments are one-way."""
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_STREET_ONEWAY_SQL)
        conn.execute(NORMALIZE_NAME_FUNCTION_SQL)
        conn.execute(MATCH_SQL)
        count = conn.execute("SELECT count(*) FROM street_oneway WHERE direction <> 0").fetchone()[0]
        conn.commit()
    return count


def update_osm_oneway(dsn: str, states, data_dir: Path) -> int:
    """Download -> load -> match, for the given states. Returns the one-way segment count."""
    paths = []
    for state_abbr in states:
        print(f"[{date.today()}] downloading OSM extract for {state_abbr} ({extract_url(state_abbr)})...")
        paths.append(download_extract(state_abbr, data_dir))
    ways = load_osm_ways(dsn, paths)
    print(f"[{date.today()}] loaded {ways} drivable OSM ways")
    count = refresh_street_oneway(dsn)
    print(f"[{date.today()}] {count} TIGER segments marked one-way from OSM")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("dsn", help='psycopg connection string, e.g. "dbname=geocoding"')
    parser.add_argument("--states", nargs="+", default=["ME", "NH"], help="States to load (default: ME NH)")
    parser.add_argument("--data-dir", type=Path, default=Path("data/osm"), help="Where to save the .osm.pbf extracts")
    args = parser.parse_args()
    try:
        update_osm_oneway(args.dsn, args.states, args.data_dir)
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
