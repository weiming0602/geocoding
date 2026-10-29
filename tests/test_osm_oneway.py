"""osm_oneway.py: OSM tag interpretation, reading ways from an OSM file,
and matching OSM one-way restrictions onto TIGER segments.

Synthetic data near Freeport, ME (so the UTM 19N matching projection is
realistic). Every scenario sits on its own north-south line, 0.01 degrees
(~800 m) of longitude from the next, so they can't match each other.
0.001 degrees of latitude is ~111 m.
"""

import psycopg
import pytest

from geocoding.osm_oneway import (
    CREATE_OSM_WAYS_SQL,
    is_drivable,
    oneway_direction,
    prepare_osm_ways,
    read_drivable_ways,
    refresh_street_oneway,
)
from geocoding.routing_topology import refresh_routing_topology
from geocoding.schema import CREATE_INDEXES_SQL, CREATE_STREET_NAMES_TABLE_SQL, CREATE_TABLE_SQL

LAT0 = 43.85


def line(lon, lat_start, lat_end):
    return f"LINESTRING ({lon} {lat_start}, {lon} {lat_end})"


# ---------------------------------------------------------------- tags


@pytest.mark.parametrize(
    "tags, expected",
    [
        ({"highway": "residential", "oneway": "yes"}, 1),
        ({"highway": "residential", "oneway": "1"}, 1),
        ({"highway": "residential", "oneway": "-1"}, -1),
        ({"highway": "residential", "oneway": "no"}, 0),
        ({"highway": "residential"}, 0),
        ({"highway": "residential", "junction": "roundabout"}, 1),
        ({"highway": "motorway"}, 1),
        ({"highway": "motorway_link"}, 1),
        ({"highway": "motorway", "oneway": "no"}, 0),
        # Direction changes by time of day: no single direction to commit to.
        ({"highway": "primary", "oneway": "reversible"}, 0),
    ],
)
def test_oneway_direction(tags, expected):
    assert oneway_direction(tags) == expected


def test_is_drivable():
    assert is_drivable({"highway": "residential"})
    assert is_drivable({"highway": "service"})
    assert not is_drivable({"highway": "service", "service": "driveway"})
    assert not is_drivable({"highway": "footway"})
    assert not is_drivable({"highway": "residential", "access": "private"})
    assert not is_drivable({"highway": "pedestrian", "area": "yes"})


def test_read_drivable_ways_from_an_osm_file(tmp_path):
    osm = tmp_path / "tiny.osm"
    osm.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="43.850" lon="-70.10" version="1"/>
  <node id="2" lat="43.851" lon="-70.10" version="1"/>
  <node id="3" lat="43.852" lon="-70.10" version="1"/>
  <way id="10" version="1"><nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/><tag k="name" v="Grove Street"/><tag k="oneway" v="-1"/></way>
  <way id="11" version="1"><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="footway"/></way>
  <way id="12" version="1"><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="motorway_link"/></way>
</osm>
"""
    )
    ways = list(read_drivable_ways(osm))
    assert [(w[0], w[1], w[2], w[4]) for w in ways] == [
        (10, "residential", "Grove Street", -1),
        (12, "motorway_link", None, 1),
    ]
    assert ways[0][5] == "LINESTRING(-70.1 43.85,-70.1 43.851)"


# ------------------------------------------------------------ matching


def _setup(conn, streets, osm_ways, alternate_names=()):
    """streets: (tlid, fullname, wkt[, mtfcc]) drawn tnidf -> tnidt.
    osm_ways: (osm_id, highway, name, ref, oneway, wkt).
    alternate_names: (tlid, fullname) rows for street_names."""
    conn.execute(CREATE_TABLE_SQL)
    conn.execute(CREATE_INDEXES_SQL)
    conn.execute(CREATE_STREET_NAMES_TABLE_SQL)
    for tlid, fullname, wkt, *rest in streets:
        mtfcc = rest[0] if rest else "S1400"
        conn.execute(
            """INSERT INTO streets (tlid, fullname, mtfcc, geometry, geom, tnidf, tnidt)
               VALUES (%s, %s, %s, %s, ST_GeomFromText(%s, 4326), %s, %s)""",
            (tlid, fullname, mtfcc, wkt, wkt, f"{tlid}-from", f"{tlid}-to"),
        )
        conn.execute("INSERT INTO street_names (tlid, fullname, paflag) VALUES (%s, %s, 'P')", (tlid, fullname))
    for tlid, fullname in alternate_names:
        conn.execute("INSERT INTO street_names (tlid, fullname, paflag) VALUES (%s, %s, 'A')", (tlid, fullname))
    conn.execute(CREATE_OSM_WAYS_SQL)
    for osm_id, highway, name, ref, oneway, wkt in osm_ways:
        conn.execute(
            """INSERT INTO osm_ways (osm_id, highway, name, ref, oneway, geom)
               VALUES (%s, %s, %s, %s, %s, ST_GeomFromText(%s, 4326))""",
            (osm_id, highway, name, ref, oneway, wkt),
        )
    prepare_osm_ways(conn)
    conn.commit()


def _directions(conn):
    """One-way restrictions only (direction 0 rows = confirmed two-way)."""
    return dict(conn.execute("SELECT tlid, direction FROM street_oneway WHERE direction <> 0").fetchall())


STREETS = [
    ("grove", "Grove St", line(-70.10, LAT0, LAT0 + 0.001)),  # drawn northward
    ("main", "Main St", line(-70.11, LAT0, LAT0 + 0.001)),
    ("elm", "Elm St", line(-70.12, LAT0, LAT0 + 0.001)),
    ("oak", "Oak St", line(-70.13, LAT0, LAT0 + 0.001)),
    ("maple", "Maple Ave", line(-70.14, LAT0, LAT0 + 0.001)),
    ("ramp-short", "", line(-70.15, LAT0, LAT0 + 0.00013)),  # ~14 m
    ("ramp-long", "", line(-70.16, LAT0, LAT0 + 0.001)),
    ("i295", "I- 295", line(-70.17, LAT0, LAT0 + 0.001)),
]
OSM_WAYS = [
    # One-way, drawn southward = against the TIGER segment -> direction -1.
    (1, "residential", "Grove Street", None, 1, line(-70.10, LAT0 + 0.0011, LAT0 - 0.0001)),
    # One-way, drawn the same way as TIGER -> direction 1.
    (2, "residential", "Main Street", None, 1, line(-70.11, LAT0 - 0.0001, LAT0 + 0.0011)),
    # Two-way -> no restriction recorded.
    (3, "residential", "Elm Street", None, 0, line(-70.12, LAT0 - 0.0001, LAT0 + 0.0011)),
    # One-way but a different street -> not trusted.
    (4, "residential", "Pine Street", None, 1, line(-70.13, LAT0 - 0.0001, LAT0 + 0.0011)),
    # A two-way Maple Ave right on top of the segment, and a one-way
    # unnamed ramp ~10 m beside it (lower osm_id, so an id tie-break would
    # wrongly pick it) -> the named two-way street wins, no restriction.
    (6, "secondary", "Maple Avenue", None, 0, line(-70.14, LAT0 - 0.0001, LAT0 + 0.0011)),
    (5, "motorway_link", None, None, 1, line(-70.14012, LAT0 - 0.0001, LAT0 + 0.0011)),
    # Unnamed on both sides: only trusted on a segment of >= 20 m.
    (7, "motorway_link", None, None, 1, line(-70.15, LAT0 - 0.0001, LAT0 + 0.0011)),
    (8, "motorway_link", None, None, 1, line(-70.16, LAT0 - 0.0001, LAT0 + 0.0011)),
    # Matched by route ref when OSM has no name.
    (9, "motorway", None, "I 295", 1, line(-70.17, LAT0 + 0.0011, LAT0 - 0.0001)),
]


def test_refresh_street_oneway_records_direction_relative_to_the_tiger_segment(dsn):
    with psycopg.connect(dsn) as conn:
        _setup(conn, STREETS, OSM_WAYS)
    assert refresh_street_oneway(dsn) == 4
    with psycopg.connect(dsn) as conn:
        assert _directions(conn) == {"grove": -1, "main": 1, "ramp-long": 1, "i295": -1}


def test_refresh_street_oneway_replaces_the_previous_run(dsn):
    with psycopg.connect(dsn) as conn:
        _setup(conn, STREETS, OSM_WAYS)
    refresh_street_oneway(dsn)
    with psycopg.connect(dsn) as conn:
        conn.execute("UPDATE osm_ways SET oneway = 0 WHERE osm_id = 1")  # Grove St reopened both ways
        conn.commit()
    refresh_street_oneway(dsn)
    with psycopg.connect(dsn) as conn:
        assert "grove" not in _directions(conn)


def test_routing_edges_view_turns_street_oneway_into_cost_and_reverse_cost(dsn):
    with psycopg.connect(dsn) as conn:
        _setup(conn, STREETS, OSM_WAYS)
    refresh_routing_topology(dsn)  # creates the (empty) street_oneway table and the view
    with psycopg.connect(dsn) as conn:
        before = conn.execute("SELECT count(*) FROM streets_routing_edges WHERE cost < 0 OR reverse_cost < 0").fetchone()
        assert before[0] == 0  # nothing one-way until OSM is matched
    refresh_street_oneway(dsn)
    with psycopg.connect(dsn) as conn:
        rows = dict(
            (tlid, (cost > 0, reverse_cost > 0))
            for tlid, cost, reverse_cost in conn.execute(
                """SELECT s.tlid, e.cost, e.reverse_cost
                   FROM streets_routing_edges e JOIN streets s ON s.id = e.id"""
            ).fetchall()
        )
    assert rows["grove"] == (False, True)  # only end -> start
    assert rows["main"] == (True, False)  # only start -> end
    assert rows["elm"] == (True, True)  # two-way


# The matching refinements found by running this against real Maine/NH
# data: route numbers written differently, TIGER alternate names, short
# ramp pieces, and one OSM road split into several ways.
REFINEMENT_STREETS = [
    ("nh101", "State Rte 101", line(-70.20, LAT0, LAT0 + 0.001), "S1100"),
    ("leeman", "Leeman Hwy", line(-70.21, LAT0, LAT0 + 0.001), "S1100"),
    ("tpke", "Spaulding Tpke", line(-70.22, LAT0, LAT0 + 0.001), "S1100"),
    ("ramp-piece", "", line(-70.23, LAT0, LAT0 + 0.00013), "S1630"),  # ~14 m, on an OSM ramp
    ("split", "Fore St", line(-70.24, LAT0, LAT0 + 0.002)),  # ~222 m, OSM splits it in two
]
REFINEMENT_OSM_WAYS = [
    (20, "motorway", None, "NH 101", 1, line(-70.20, LAT0 - 0.0001, LAT0 + 0.0011)),
    (21, "motorway", None, "US 1", 1, line(-70.21, LAT0 - 0.0001, LAT0 + 0.0011)),
    (22, "motorway", "Spaulding Turnpike", None, 1, line(-70.22, LAT0 - 0.0001, LAT0 + 0.0011)),
    (23, "motorway_link", None, None, 1, line(-70.23, LAT0 - 0.0001, LAT0 + 0.0011)),
    # Each half alone covers ~50% of the segment -- only together >= 80%.
    (24, "residential", "Fore Street", None, 1, line(-70.24, LAT0 - 0.0001, LAT0 + 0.001)),
    (25, "residential", "Fore Street", None, 1, line(-70.24, LAT0 + 0.001, LAT0 + 0.0021)),
]


def test_refresh_street_oneway_handles_route_numbers_alternate_names_ramp_pieces_and_split_ways(dsn):
    with psycopg.connect(dsn) as conn:
        _setup(conn, REFINEMENT_STREETS, REFINEMENT_OSM_WAYS, alternate_names=[("leeman", "US Hwy 1")])
    refresh_street_oneway(dsn)
    with psycopg.connect(dsn) as conn:
        assert _directions(conn) == {"nh101": 1, "leeman": 1, "tpke": 1, "ramp-piece": 1, "split": 1}


def test_refresh_street_oneway_takes_direction_from_the_nearer_carriageway(dsn):
    # A divided highway: OSM draws each direction as its own one-way way,
    # here ~2 m (northbound) and ~10 m (southbound) from TIGER's
    # northbound line -- both inside the 15 m corridor, both fully
    # covering it, same name. The southbound way has the lower osm_id, so
    # an id tie-break would flip TIGER's northbound carriageway to
    # southbound-only.
    streets = [("i95-nb", "I- 95", line(-70.30, LAT0, LAT0 + 0.001), "S1100")]
    osm_ways = [
        (30, "motorway", None, "I 95", 1, line(-70.30012, LAT0 + 0.0011, LAT0 - 0.0001)),  # southbound, ~10 m west
        (31, "motorway", None, "I 95", 1, line(-70.29997, LAT0 - 0.0001, LAT0 + 0.0011)),  # northbound, ~2 m east
    ]
    with psycopg.connect(dsn) as conn:
        _setup(conn, streets, osm_ways)
    refresh_street_oneway(dsn)
    with psycopg.connect(dsn) as conn:
        assert _directions(conn) == {"i95-nb": 1}
        assert conn.execute("SELECT osm_id FROM street_oneway").fetchone()[0] == 31


def test_routing_edges_view_closes_highways_and_ramps_of_unknown_direction(dsn):
    # Limited-access highways/ramps (S1100/S1630) are almost always one-way:
    # with no confident OSM match, routing must not use them at all rather
    # than treat them as two-way. One OSM confirms is two-way stays open,
    # and an ordinary street with no match stays two-way as before.
    streets = [
        ("hwy-unknown", "I- 95", line(-70.40, LAT0, LAT0 + 0.001), "S1100"),
        ("ramp-unknown", "", line(-70.41, LAT0, LAT0 + 0.001), "S1630"),
        ("hwy-two-way", "Spaulding Tpke", line(-70.42, LAT0, LAT0 + 0.001), "S1100"),
        ("street-unknown", "Quiet Ln", line(-70.43, LAT0, LAT0 + 0.001), "S1400"),
    ]
    osm_ways = [(40, "motorway", "Spaulding Turnpike", None, 0, line(-70.42, LAT0 - 0.0001, LAT0 + 0.0011))]
    with psycopg.connect(dsn) as conn:
        _setup(conn, streets, osm_ways)
    refresh_routing_topology(dsn)
    refresh_street_oneway(dsn)
    with psycopg.connect(dsn) as conn:
        rows = dict(
            (tlid, (cost > 0, reverse_cost > 0))
            for tlid, cost, reverse_cost in conn.execute(
                """SELECT s.tlid, e.cost, e.reverse_cost
                   FROM streets_routing_edges e JOIN streets s ON s.id = e.id"""
            ).fetchall()
        )
    assert rows["hwy-unknown"] == (False, False)
    assert rows["ramp-unknown"] == (False, False)
    assert rows["hwy-two-way"] == (True, True)
    assert rows["street-unknown"] == (True, True)


# ------------------------------------------------- state-by-state update


def _write_osm(path, ways):
    """Writes (osm_id, highway, name, ref, oneway, wkt) ways as an .osm XML file."""
    nodes, way_xml, node_id = [], [], 1000
    for osm_id, highway, name, ref, oneway, wkt in ways:
        coords = [c.split() for c in wkt[wkt.index("(") + 1 : wkt.index(")")].split(",")]
        refs = []
        for lon, lat in coords:
            node_id += 1
            nodes.append(f'<node id="{node_id}" lat="{lat}" lon="{lon}" version="1"/>')
            refs.append(f'<nd ref="{node_id}"/>')
        tags = [f'<tag k="highway" v="{highway}"/>']
        if name:
            tags.append(f'<tag k="name" v="{name}"/>')
        if ref:
            tags.append(f'<tag k="ref" v="{ref}"/>')
        tags.append(f'<tag k="oneway" v="{ {1: "yes", -1: "-1", 0: "no"}[oneway] }"/>')
        way_xml.append(f'<way id="{osm_id}" version="1">{"".join(refs)}{"".join(tags)}</way>')
    path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">' + "".join(nodes + way_xml) + "</osm>\n")
    return path


def _fake_downloads(monkeypatch, files):
    """Makes update_osm_oneway read local files instead of Geofabrik: {state: path or exception}."""
    import geocoding.osm_oneway as osm_oneway

    def download(state_abbr, data_dir):
        result = files[state_abbr]
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(osm_oneway, "download_extract", download)


def _table_count(conn, table):
    return conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


def test_update_osm_oneway_matches_state_by_state_and_keeps_no_raw_osm_roads(dsn, tmp_path, monkeypatch):
    from geocoding.osm_oneway import update_osm_oneway

    with psycopg.connect(dsn) as conn:
        _setup(conn, STREETS, [])
    # The same ways as the single-load tests above, split across two "states".
    _fake_downloads(monkeypatch, {
        "ME": _write_osm(tmp_path / "me.osm", [w for w in OSM_WAYS if w[0] <= 4]),
        "NH": _write_osm(tmp_path / "nh.osm", [w for w in OSM_WAYS if w[0] > 4]),
    })
    assert update_osm_oneway(dsn, ["ME", "NH"], tmp_path) == 4
    with psycopg.connect(dsn) as conn:
        # Same answers as matching everything at once...
        assert _directions(conn) == {"grove": -1, "main": 1, "ramp-long": 1, "i295": -1}
        # ...and only street_oneway is kept: no raw OSM roads, no leftovers.
        assert _table_count(conn, "osm_ways") == 0
        assert _table_count(conn, "osm_match_pairs") == 0


def test_update_osm_oneway_picks_the_best_match_across_states(dsn, tmp_path, monkeypatch):
    # A segment near a state line, seen by both states' OSM data: a short
    # one-way piece in one (too little coverage to trust) and the full,
    # two-way street in the other. The better match wins whichever state
    # comes first.
    from geocoding.osm_oneway import update_osm_oneway

    border = [("border", "Line Rd", line(-70.18, LAT0, LAT0 + 0.001))]
    partial_oneway = (20, "residential", "Line Road", None, 1, line(-70.18, LAT0 - 0.0001, LAT0 + 0.0004))
    full_twoway = (21, "residential", "Line Road", None, 0, line(-70.18, LAT0 - 0.0001, LAT0 + 0.0011))
    with psycopg.connect(dsn) as conn:
        _setup(conn, border, [])
    for order in (["ME", "NH"], ["NH", "ME"]):
        _fake_downloads(monkeypatch, {
            "ME": _write_osm(tmp_path / "me.osm", [partial_oneway]),
            "NH": _write_osm(tmp_path / "nh.osm", [full_twoway]),
        })
        update_osm_oneway(dsn, order, tmp_path)
        with psycopg.connect(dsn) as conn:
            assert conn.execute("SELECT direction, osm_id FROM street_oneway WHERE tlid = 'border'").fetchone() == (0, 21)


def test_update_osm_oneway_failing_partway_keeps_the_previous_one_way_data(dsn, tmp_path, monkeypatch):
    from geocoding.osm_oneway import update_osm_oneway

    with psycopg.connect(dsn) as conn:
        _setup(conn, STREETS, [])
    _fake_downloads(monkeypatch, {"ME": _write_osm(tmp_path / "me.osm", OSM_WAYS)})
    update_osm_oneway(dsn, ["ME"], tmp_path)

    _fake_downloads(monkeypatch, {
        "ME": _write_osm(tmp_path / "me2.osm", []),  # would wipe every restriction...
        "NH": RuntimeError("download failed"),  # ...but the run fails before applying
    })
    with pytest.raises(RuntimeError):
        update_osm_oneway(dsn, ["ME", "NH"], tmp_path)
    with psycopg.connect(dsn) as conn:
        assert _directions(conn) == {"grove": -1, "main": 1, "ramp-long": 1, "i295": -1}
        assert _table_count(conn, "osm_ways") == 0


def test_a_road_in_both_states_extracts_is_not_counted_twice(dsn, tmp_path, monkeypatch):
    # Geofabrik puts a road that crosses a state line in BOTH states'
    # extracts. Loading both used to double its coverage of a TIGER
    # segment: half a segment's length looked like all of it, so a one-way
    # restriction got recorded from too little evidence (59 Maine/NH
    # border segments). Each (segment, way) pair now counts once.
    from geocoding.osm_oneway import update_osm_oneway

    half_way = (30, "residential", "Border Rd", None, 1, line(-70.19, LAT0 - 0.0001, LAT0 + 0.0005))
    with psycopg.connect(dsn) as conn:
        _setup(conn, [("border2", "Border Rd", line(-70.19, LAT0, LAT0 + 0.001))], [])
    _fake_downloads(monkeypatch, {
        "ME": _write_osm(tmp_path / "me.osm", [half_way]),
        "NH": _write_osm(tmp_path / "nh.osm", [half_way]),
    })
    update_osm_oneway(dsn, ["ME", "NH"], tmp_path)
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SELECT count(*) FROM street_oneway WHERE tlid = 'border2'").fetchone()[0] == 0
