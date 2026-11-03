"""Stage 1b of address_inference: street names + street identification."""

import psycopg
import pytest

from address_inference.regions import parse_region
from address_inference.street_match import match_street, match_town
from address_inference.street_names import base_name, canonical
from geocoding.schema import (
    CREATE_ADDRESS_POINTS_TABLE_SQL,
    CREATE_STREET_NAMES_TABLE_SQL,
    CREATE_TABLE_SQL,
)

ME = parse_region(
    {"id": "me", "name": "Maine", "state_fips": "23", "state_abbr": "ME", "footprints": {"source": "usa_structures"}}
)


# --- canonical names (real E911 / TIGER pairs from Freeport and Maine) -----


@pytest.mark.parametrize(
    "e911, tiger",
    [
        ("SOUTH FREEPORT ROAD", "S Freeport Rd"),
        ("US ROUTE ONE", "US Hwy 1"),
        ("ROUTE 1", "US Rte 1"),
        ("STATE HIGHWAY 3", "State Rte 3"),
        ("US ROUTE 2 WEST", "US Hwy 2 W"),
        ("OLD ROUTE 1", "Old Rte 1"),
        ("INTERSTATE 295", "I- 295"),
        ("MAIN STREET SOUTH", "Main St S"),
        ("MAST LANDING ROAD", "Mast Lndg Rd"),
        ("WOLFE'S NECK ROAD", "Wolfes Neck Rd"),
        ("SAINT JOHN STREET", "St John St"),
        ("HIGHWAY 1 BYPASS", "Hwy 1 Byp"),
    ],
)
def test_canonical_makes_e911_and_tiger_spellings_equal(e911, tiger):
    assert canonical(e911) == canonical(tiger)


def test_canonical_keeps_number_words_that_arent_route_numbers():
    assert canonical("ONE ROD ROAD") == "ONE ROD RD"


def test_canonical_keeps_different_streets_different():
    assert canonical("PINE HILL ROAD") != canonical("Pine Rd")
    assert canonical("ROUTE 1") != canonical("Route 1A")


def test_base_name_drops_only_the_road_type():
    assert base_name(canonical("ROOS HILL DRIVE")) == base_name(canonical("Roos Hill Rd")) == "ROOS HILL"
    assert base_name(canonical("SOMERSET CONDOS")) == base_name(canonical("Somerset")) == "SOMERSET"
    assert base_name(canonical("MAIN STREET SOUTH")) == "MAIN"
    assert base_name("WAY") == ""  # a bare type word must not match everything


# --- match_street decision rules -------------------------------------------


def cands(name, points, tlid="t1", alias=False):
    return [(p, tlid, name, alias) for p in points]


def test_exact_name_matches_even_with_low_support():
    # TIGER's road stops short of most of the houses (Freeport's Cortland Rd).
    m = match_street("CORTLAND ROAD", 10, cands("Cortland Rd", [1]))
    assert (m.status, m.method, m.tiger_name, m.support) == ("matched", "exact", "Cortland Rd", 0.1)


def test_alias_only_name_is_reported_as_alias():
    m = match_street("US ROUTE ONE", 2, cands("US Hwy 1", [1, 2], alias=True) + cands("Main St", [1, 2], tlid="t1"))
    assert (m.method, m.tiger_name) == ("alias", "US Hwy 1")


def test_fuzzy_needs_close_spelling_and_most_points():
    assert match_street("MALLETT DRIVE", 4, cands("Mallet Dr", [1, 2, 3])).method == "fuzzy"
    assert match_street("MALLETT DRIVE", 4, cands("Mallet Dr", [1])).status == "unmatched"


def test_base_name_match_is_its_own_method():
    m = match_street("ROOS HILL DRIVE", 2, cands("Roos Hill Rd", [1, 2]))
    assert (m.method, m.tiger_name) == ("base_name", "Roos Hill Rd")


def test_exact_beats_fuzzy_and_collects_every_segment():
    rows = cands("Bow St", [1, 2], tlid="a") + cands("Bow St", [3], tlid="b") + cands("Bowe St", [1, 2, 3], tlid="c")
    m = match_street("BOW STREET", 3, rows)
    assert (m.method, m.tlids) == ("exact", ("a", "b"))


def test_unmatched_reasons():
    # Points beside another road: a naming problem, never forced onto it.
    m = match_street("CONWAY STREET", 2, cands("Desert Rd", [1, 2]))
    assert (m.status, m.unmatched_reason, m.nearest_tiger_name, m.tlids) == ("unmatched", "name_mismatch", "Desert Rd", ())
    # Most points have no TIGER segment at all nearby; unnamed ones still count as a road.
    assert match_street("ROGERS ROAD", 4, cands(None, [1])).unmatched_reason == "no_road_nearby"
    assert match_street("ROGERS ROAD", 2, cands(None, [1, 2])).unmatched_reason == "name_mismatch"
    assert match_street("NOWHERE LANE", 3, []).unmatched_reason == "no_road_nearby"


# --- against Postgres ------------------------------------------------------


def test_match_town_ignores_zip_and_replaces_previous_rows(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_TABLE_SQL)
        conn.execute(CREATE_STREET_NAMES_TABLE_SQL)
        conn.execute(CREATE_ADDRESS_POINTS_TABLE_SQL)
        # TIGER gives this segment another area's ZIP; matching must not care.
        conn.execute(
            """INSERT INTO streets (tlid, fullname, zipl, zipr, state_abbr, geometry, geom)
               VALUES ('100', 'Rogers Rd', '04096', '04096', 'ME',
                       'LINESTRING(-70.100 43.850, -70.090 43.850)',
                       ST_GeomFromText('LINESTRING(-70.100 43.850, -70.090 43.850)', 4326))"""
        )
        conn.execute(
            """INSERT INTO address_points (site_uid, address_number, street_fullname, town, state_abbr, geom) VALUES
               ('a', 10, 'ROGERS ROAD', 'Freeport', 'ME', ST_SetSRID(ST_MakePoint(-70.095, 43.8503), 4326)),
               ('b', 12, 'ROGERS ROAD', 'Freeport', 'ME', ST_SetSRID(ST_MakePoint(-70.094, 43.8503), 4326)),
               ('c', 1, 'HIDDEN CONDOS', 'Freeport', 'ME', ST_SetSRID(ST_MakePoint(-70.050, 43.900), 4326))"""
        )

    match_town(dsn, ME, "Freeport")
    match_town(dsn, ME, "Freeport")  # re-run replaces, doesn't duplicate

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            """SELECT label_street, status, method, unmatched_reason
               FROM address_inference.street_matches ORDER BY label_street"""
        ).fetchall()
        segments = conn.execute("SELECT label_street, tlid FROM address_inference.street_match_segments").fetchall()
    assert rows == [
        ("HIDDEN CONDOS", "unmatched", None, "no_road_nearby"),
        ("ROGERS ROAD", "matched", "exact", None),
    ]
    assert segments == [("ROGERS ROAD", "100")]


def test_match_town_rejects_unknown_town(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_ADDRESS_POINTS_TABLE_SQL)
    with pytest.raises(ValueError, match="no label points"):
        match_town(dsn, ME, "Atlantis")
