"""Feasibility spike: proves pgr_ksp returns real, distinct hazard-avoiding
routes over topology built from our own streets/tnidf/tnidt data.

Requires the pgrouting extension to be installed at the OS level
(`sudo apt install postgresql-18-pgrouting`) -- scoped to just this file's
own CREATE EXTENSION call (not the shared conftest.py dsn fixture every
other test uses), so a box without pgrouting installed only fails this
one file, not the whole suite.

Synthetic network (not real TIGER data -- proving the graph/pgRouting
mechanics, not this particular map):

    N4 -------- N5        (top detour: N1-N4-N5-N3)
   /                `.
  N1 ---- N2 ---- N3      (direct path, blocked by a hazard at N2)
   `.                /
    N6 -------- N7        (bottom detour: N1-N6-N7-N3)

With the hazard's buffer excluding the two direct-path edges (N1-N2,
N2-N3), pgr_ksp(k=2) should return exactly the two detour routes, never
touching the excluded edges.
"""

import psycopg
import pytest

from geocoding.routing_topology import refresh_routing_topology
from geocoding.schema import CREATE_INDEXES_SQL, CREATE_TABLE_SQL

NODES = {
    "N1": (0.000, 0.000),
    "N2": (0.001, 0.000),  # hazard sits here
    "N3": (0.002, 0.000),
    "N4": (0.000, 0.001),
    "N5": (0.002, 0.001),
    "N6": (0.000, -0.001),
    "N7": (0.002, -0.001),
}

# (tlid, from-node, to-node)
EDGES = [
    ("E1", "N1", "N2"),  # direct path, first half -- excluded by the hazard
    ("E2", "N2", "N3"),  # direct path, second half -- excluded by the hazard
    ("E3", "N1", "N4"),  # top detour
    ("E4", "N4", "N5"),
    ("E5", "N5", "N3"),
    ("E6", "N1", "N6"),  # bottom detour
    ("E7", "N6", "N7"),
    ("E8", "N7", "N3"),
]


def _insert_synthetic_network(conn):
    """Inserts EDGES/NODES directly into `streets` -- direct SQL rather than
    a synthetic shapefile + ingest(), since this test is proving the
    topology/pgRouting graph logic, not ingest.py's field mapping (that's
    covered separately in test_ingest.py's own tnidf/tnidt backfill test).
    Returns {tlid: streets.id} so the test can assert on specific edges.
    """
    ids = {}
    for tlid, from_node, to_node in EDGES:
        lon1, lat1 = NODES[from_node]
        lon2, lat2 = NODES[to_node]
        wkt = f"LINESTRING ({lon1} {lat1}, {lon2} {lat2})"
        row = conn.execute(
            """
            INSERT INTO streets (tlid, geometry, geom, tnidf, tnidt)
            VALUES (%s, %s, ST_GeomFromText(%s, 4326), %s, %s)
            RETURNING id
            """,
            (tlid, wkt, wkt, from_node, to_node),
        ).fetchone()
        ids[tlid] = row[0]
    conn.commit()
    return ids


def _nearest_node(conn, lon, lat):
    row = conn.execute(
        """
        SELECT id FROM streets_topology_nodes
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
        LIMIT 1
        """,
        (lon, lat),
    ).fetchone()
    return row[0]


@pytest.fixture
def routing_dsn(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS pgrouting")
        conn.commit()
    return dsn


def test_pgr_ksp_returns_two_distinct_hazard_avoiding_routes(routing_dsn):
    with psycopg.connect(routing_dsn) as conn:
        conn.execute(CREATE_TABLE_SQL)
        conn.execute(CREATE_INDEXES_SQL)
        edge_ids = _insert_synthetic_network(conn)

    refresh_routing_topology(routing_dsn)

    with psycopg.connect(routing_dsn) as conn:
        start_node = _nearest_node(conn, *NODES["N1"])
        end_node = _nearest_node(conn, *NODES["N3"])
        hazard_lon, hazard_lat = NODES["N2"]

        # The hazard buffer's radius/point are validated floats embedded
        # directly into pgr_ksp's edges-SQL text argument -- pgRouting
        # EXECUTEs that string itself, so it can't be a normal bound
        # parameter of the outer query. Safe here because both values are
        # Python floats from our own NODES dict, never client-supplied
        # strings -- not a general string-concatenation pattern to copy
        # for anything touching real request input.
        edges_sql = (
            "SELECT id, source, target, cost FROM streets_routing_edges "
            "WHERE NOT ST_DWithin(geom::geography, "
            f"ST_SetSRID(ST_MakePoint({hazard_lon}, {hazard_lat}), 4326)::geography, {60})"
        )

        rows = conn.execute(
            "SELECT path_id, edge FROM pgr_ksp(%s, %s, %s, %s, %s) ORDER BY path_id, path_seq",
            (edges_sql, start_node, end_node, 2, False),
        ).fetchall()

    paths = {}
    for path_id, edge in rows:
        paths.setdefault(path_id, []).append(edge)

    assert len(paths) == 2, f"expected 2 distinct routes, got {len(paths)}: {paths}"

    excluded_edge_ids = {edge_ids["E1"], edge_ids["E2"]}
    for path_id, edges in paths.items():
        used_edge_ids = {e for e in edges if e != -1}  # -1 marks the final (no-outgoing-edge) row
        assert not (used_edge_ids & excluded_edge_ids), (
            f"path {path_id} used an edge inside the hazard buffer: {used_edge_ids}"
        )
        assert len(used_edge_ids) == 3, f"expected each detour to be 3 edges, got {used_edge_ids}"
