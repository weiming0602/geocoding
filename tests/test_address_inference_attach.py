"""Stage 2 of address_inference: attaching buildings to street segments."""

import psycopg
import pytest

from address_inference.attach import attach, ensure_tables
from address_inference.regions import parse_region
from address_inference.schema import ensure_structures_tables
from geocoding.schema import CREATE_TABLE_SQL, CREATE_TOWNS_TABLE_SQL

ME = parse_region(
    {"id": "me", "name": "Maine", "state_fips": "23", "state_abbr": "ME", "footprints": {"source": "usa_structures"}}
)

# Main St runs west -> east along latitude 43.85, ~800 m long, with ranges
# on both sides. Its LEFT side (digitized direction east) is north.
MAIN = ("1", "Main St", "1", "99", "2", "98", "LINESTRING(-70.105 43.85, -70.095 43.85)")
# A segment with no address ranges at all (e.g. a highway): never a candidate.
HIGHWAY = ("2", "I- 295", "", "", "", "", "LINESTRING(-70.105 43.8505, -70.095 43.8505)")
# Left-side range only.
LANE = ("3", "Lane Rd", "1", "9", "", "", "LINESTRING(-70.10 43.851, -70.10 43.852)")


def setup_db(dsn, buildings, streets=(MAIN, HIGHWAY, LANE)):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_TABLE_SQL)
        conn.execute(CREATE_TOWNS_TABLE_SQL)
        for tlid, name, lf, lt, rf, rt, wkt in streets:
            conn.execute(
                """INSERT INTO streets (tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, state_abbr, geometry, geom)
                   VALUES (%s, %s, %s, %s, %s, %s, 'ME', %s, ST_GeomFromText(%s, 4326))""",
                (tlid, name, lf, lt, rf, rt, wkt, wkt),
            )
        ensure_structures_tables(conn, "23")
        for source_id, lon, lat, county in buildings:
            conn.execute(
                """INSERT INTO address_inference.structures
                   (state_fips, county_fips, source, source_id, geom, inner_point)
                   VALUES ('23', %s, 'usa_structures', %s,
                           ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 0.00005)),
                           ST_SetSRID(ST_MakePoint(%s, %s), 4326))""",
                (county, source_id, lon, lat, lon, lat),
            )
        conn.execute(
            """INSERT INTO towns (geoid, state_abbr, name, geom)
               VALUES ('t', 'ME', 'Testtown', ST_Multi(ST_MakeEnvelope(-70.2, 43.8, -70.0, 43.9, 4326)))"""
        )


def rows(dsn, source_id):
    with psycopg.connect(dsn) as conn:
        return conn.execute(
            """SELECT tlid, side, at_end, round(dist_m), rank, range_on_side
               FROM address_inference.building_segments WHERE source_id = %s ORDER BY rank""",
            (source_id,),
        ).fetchall()


def test_side_follows_the_digitized_direction(dsn):
    setup_db(dsn, [("north", -70.1, 43.8502, "23005"), ("south", -70.1, 43.8498, "23005")])
    attach(dsn, ME, county_fips="23005", progress=lambda _: None)
    # ~22 m north of Main St = its left side; the range-less highway (~33 m
    # away) is never a candidate. Lane Rd starts ~89 m due north, so the
    # building is exactly on its extension: no side at all (collinear).
    assert rows(dsn, "north") == [("1", "L", False, 22, 1, True), ("3", None, True, 89, 2, False)]
    assert rows(dsn, "south")[0] == ("1", "R", False, 22, 1, True)


def test_building_past_the_end_of_a_segment_is_flagged(dsn):
    setup_db(dsn, [("east", -70.094, 43.8501, "23005")])  # ~80 m past Main St's east end
    attach(dsn, ME, county_fips="23005", progress=lambda _: None)
    tlid, side, at_end, dist, rank, _ = rows(dsn, "east")[0]
    assert (tlid, side, at_end, rank) == ("1", "L", True, 1)
    assert 75 <= dist <= 90


def test_only_segments_within_200_m(dsn):
    setup_db(dsn, [("far", -70.1, 43.8475, "23005")])  # ~280 m south of Main St
    attach(dsn, ME, county_fips="23005", progress=lambda _: None)
    assert rows(dsn, "far") == []


def test_rerun_replaces_only_the_buildings_in_scope(dsn):
    setup_db(dsn, [("a", -70.1, 43.8502, "23005"), ("b", -70.1, 43.8498, "23001")])
    attach(dsn, ME, progress=lambda _: None)  # whole state, county by county
    attach(dsn, ME, county_fips="23005", progress=lambda _: None)
    attach(dsn, ME, town="Testtown", progress=lambda _: None)
    with psycopg.connect(dsn) as conn:
        counts = conn.execute(
            "SELECT source_id, count(*) FROM address_inference.building_segments GROUP BY 1 ORDER BY 1"
        ).fetchall()
    assert counts == [("a", 2), ("b", 2)]


def test_rejects_bad_state_fips(dsn):
    with psycopg.connect(dsn) as conn, pytest.raises(ValueError):
        ensure_tables(conn, "2x")
