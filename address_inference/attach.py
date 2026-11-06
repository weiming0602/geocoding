"""Stage 2: attach each building to the TIGER street segments near it.

    python -m address_inference.attach "dbname=geocoding" me --town Freeport
    python -m address_inference.attach "dbname=geocoding" me --county 23005
    python -m address_inference.attach "dbname=geocoding" me        # whole state, county by county

For every building, EVERY addressable segment (one with a left or right
address range) within ATTACH_RADIUS_M is kept, not just the nearest: the
nearest road is often not the one a building is addressed on (corner
lots, long driveways), and later stages need the alternatives to choose
from. Per (building, segment):

  side      'L'/'R': which side of the segment's DIGITIZED direction
            (from its first vertex to its last) the building is on. Same
            convention as TIGER's lfromadd/rfromadd and interpolate.py.
            Never derived from house-number parity -- TIGER has no fixed
            odd/even side (see CLAUDE.md).
  t         0..1, where the building projects along the segment
            (ST_LineLocatePoint), comparable to range interpolation.
  at_end    the building projects past an end of the segment (t is
            exactly 0 or 1), i.e. it's beside the road's extension, not
            the road itself.
  dist_m    distance from the building's inner point to the segment.
  rank      1 = nearest segment for that building.
  range_on_side  whether the segment has an address range on that side.

Writes address_inference.building_segments (partitioned by state like
structures), replacing the rows of the buildings in scope.
"""

import argparse
import re

import psycopg

from .load_footprints import town_envelope
from .regions import load_region

ATTACH_RADIUS_M = 200
# Bounding-box prefilter in degrees, comfortably above 200 m at Maine/NH
# latitudes (1 degree of longitude is ~80 km at 44N, so 0.004 ~ 320 m).
PREFILTER_DEGREES = 0.004
# Half-width (as a fraction of the segment's length) of the stretch of
# road used as the direction of travel at the building's projection.
TANGENT_FRACTION = 0.001

CREATE_TABLE_SQL = """
CREATE SCHEMA IF NOT EXISTS address_inference;
CREATE TABLE IF NOT EXISTS address_inference.building_segments (
    state_fips TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    tlid TEXT NOT NULL,
    side CHAR(1) CHECK (side IN ('L', 'R')),
    t DOUBLE PRECISION NOT NULL,
    at_end BOOLEAN NOT NULL,
    dist_m DOUBLE PRECISION NOT NULL,
    rank INTEGER NOT NULL,
    range_on_side BOOLEAN NOT NULL,
    PRIMARY KEY (state_fips, source, source_id, tlid)
) PARTITION BY LIST (state_fips);
CREATE INDEX IF NOT EXISTS idx_ai_building_segments_tlid ON address_inference.building_segments (tlid);
"""

# A building on a deep lot is also attached to every street its tax lot
# fronts, however far back it sits: 48 Flying Point Road's house is more
# than 200 m from Flying Point Road (its nearest road is Johns Road, 131 m),
# but its lot (parcels.py: "48 FLYING POINT ROAD") runs out to Flying Point.
FRONTAGE_CLAUSE = """UNION
        SELECT st.* FROM address_inference.building_parcels bp
        JOIN address_inference.parcel_frontage pf ON pf.parcel_id = bp.parcel_id
        JOIN streets st ON st.tlid = pf.tlid
        WHERE bp.state_fips = b.state_fips AND bp.source_id = b.source_id"""

# %(scope)s is replaced (not bound) with one of the SCOPE_* clauses below.
DELETE_SQL = """
DELETE FROM address_inference.building_segments bs
USING address_inference.structures b
WHERE bs.state_fips = b.state_fips AND bs.source = b.source AND bs.source_id = b.source_id
  AND b.state_fips = %(state_fips)s AND {scope}
"""

INSERT_SQL = f"""
INSERT INTO address_inference.building_segments
    (state_fips, source, source_id, tlid, side, t, at_end, dist_m, rank, range_on_side)
SELECT b.state_fips, b.source, b.source_id, c.tlid, c.side, c.t, c.t IN (0, 1), c.dist_m,
       rank() OVER (PARTITION BY b.source, b.source_id ORDER BY c.dist_m, c.tlid),
       CASE c.side WHEN 'L' THEN c.has_left WHEN 'R' THEN c.has_right ELSE false END
FROM address_inference.structures b
CROSS JOIN LATERAL (
    SELECT st.tlid, loc.t,
           ST_Distance(st.geom::geography, b.inner_point::geography) AS dist_m,
           -- Sign of the cross product (direction of travel) x (road -> building):
           -- positive = building is on the left. Lon/lat axes are scaled by
           -- different positive factors, which never flips the sign.
           CASE sign((ST_X(tan.p2) - ST_X(tan.p1)) * (ST_Y(b.inner_point) - ST_Y(tan.p1))
                   - (ST_Y(tan.p2) - ST_Y(tan.p1)) * (ST_X(b.inner_point) - ST_X(tan.p1)))
                WHEN 1 THEN 'L' WHEN -1 THEN 'R' END AS side,
           coalesce(st.lfromadd, '') <> '' AS has_left,
           coalesce(st.rfromadd, '') <> '' AS has_right
    FROM (
        SELECT st.* FROM streets st
        WHERE st.geom && ST_Expand(b.inner_point, {PREFILTER_DEGREES})
          AND ST_DWithin(st.geom::geography, b.inner_point::geography, {ATTACH_RADIUS_M})
        {{frontage}}
    ) st
    CROSS JOIN LATERAL (SELECT ST_LineLocatePoint(st.geom, b.inner_point) AS t) loc
    CROSS JOIN LATERAL (
        SELECT ST_LineInterpolatePoint(st.geom, greatest(loc.t - {TANGENT_FRACTION}, 0)) AS p1,
               ST_LineInterpolatePoint(st.geom, least(loc.t + {TANGENT_FRACTION}, 1)) AS p2
    ) tan
    WHERE (coalesce(st.lfromadd, '') <> '' OR coalesce(st.rfromadd, '') <> '')
) c
WHERE b.state_fips = %(state_fips)s AND {{scope}}
"""

SCOPE_ENVELOPE = "b.inner_point && ST_MakeEnvelope(%(xmin)s, %(ymin)s, %(xmax)s, %(ymax)s, 4326)"
SCOPE_COUNTY = "b.county_fips = %(county)s"


def ensure_tables(conn, state_fips: str) -> None:
    if not re.fullmatch(r"\d{2}", state_fips):
        raise ValueError(f"state_fips must be two digits, got {state_fips!r}")
    conn.execute(CREATE_TABLE_SQL)
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS address_inference.building_segments_{state_fips} "
        f"PARTITION OF address_inference.building_segments FOR VALUES IN ('{state_fips}')"
    )


def _attach_scope(conn, scope_sql: str, params: dict) -> int:
    conn.execute(DELETE_SQL.format(scope=scope_sql), params)
    has_parcels = not conn.execute(
        "SELECT to_regclass('address_inference.parcel_frontage') IS NULL").fetchone()[0]
    sql = INSERT_SQL.format(scope=scope_sql, frontage=FRONTAGE_CLAUSE if has_parcels else "")
    return conn.execute(sql, params).rowcount


def attach(dsn, region, town=None, county_fips=None, progress=print) -> int:
    """Attaches the region's buildings (optionally one town's bbox or one
    county) to nearby segments. Returns the number of (building, segment)
    rows written."""
    with psycopg.connect(dsn) as conn:
        ensure_tables(conn, region.state_fips)
        params = {"state_fips": region.state_fips}

        if town:
            xmin, ymin, xmax, ymax = town_envelope(conn, region.state_abbr, town)
            written = _attach_scope(conn, SCOPE_ENVELOPE, {**params, "xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax})
        else:
            if county_fips:
                counties = [county_fips]
            else:
                counties = [r[0] for r in conn.execute(
                    "SELECT DISTINCT county_fips FROM address_inference.structures WHERE state_fips = %s ORDER BY 1",
                    (region.state_fips,),
                )]
            written = 0
            for county in counties:
                count = _attach_scope(conn, SCOPE_COUNTY, {**params, "county": county})
                conn.commit()  # one county at a time: a failure doesn't lose the others
                progress(f"  county {county}: {count} rows")
                written += count
        conn.commit()
        return written


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn")
    parser.add_argument("region")
    area = parser.add_mutually_exclusive_group()
    area.add_argument("--town", help="only buildings in this town's bounding box, e.g. Freeport")
    area.add_argument("--county", help="only this county (5-digit FIPS), e.g. 23005")
    args = parser.parse_args()
    count = attach(args.dsn, load_region(args.region), town=args.town, county_fips=args.county)
    print(f"Wrote {count} building-segment rows")


if __name__ == "__main__":
    main()
