"""Builds the pgRouting-compatible graph on top of `streets`' tnidf/tnidt.

Separate from ingest.py: this is a derived structure recomputed from
whatever's currently in `streets`, not something sourced directly from a
TIGER shapefile. Requires the `pgrouting` extension (see schema.py's
module docstring) in addition to `postgis`.
"""

import psycopg

from .schema import (
    CREATE_ROUTING_EDGES_VIEW_SQL,
    CREATE_ROUTING_TOPOLOGY_NODES_INDEXES_SQL,
    CREATE_ROUTING_TOPOLOGY_NODES_TABLE_SQL,
)

# Every streets.geom is either a LINESTRING or, rarely, a MULTILINESTRING
# (_shape_to_wkt in ingest.py only emits the latter for a shapefile record
# with multiple parts). ST_StartPoint/ST_EndPoint reject a MULTILINESTRING
# outright, and there's no ingested edge case yet to test a "resolve the
# true start/end across parts" rule against -- skip those rows for now
# rather than guess. Tracked as an open follow-up, not silent data loss:
# any street this excludes still geocodes/interpolates normally, it just
# doesn't participate in routing.
POPULATE_TOPOLOGY_NODES_SQL = """
INSERT INTO streets_topology_nodes (tnid, geom)
SELECT tnidf, ST_StartPoint(geom) FROM streets
WHERE tnidf IS NOT NULL AND GeometryType(geom) = 'LINESTRING'
UNION
SELECT tnidt, ST_EndPoint(geom) FROM streets
WHERE tnidt IS NOT NULL AND GeometryType(geom) = 'LINESTRING'
ON CONFLICT (tnid) DO NOTHING;
"""


def refresh_routing_topology(dsn: str) -> None:
    """(Re)builds streets_topology_nodes and streets_routing_edges from
    whatever's currently in `streets`. Safe to re-run: node inserts are
    ON CONFLICT DO NOTHING (existing nodes keep their id), and the edges
    view is CREATE OR REPLACE. Run after any ingest that adds/backfills
    tnidf/tnidt (a fresh ingest.py run for a state, or the one-time
    backfill across all previously-ingested rows)."""
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_ROUTING_TOPOLOGY_NODES_TABLE_SQL)
        conn.execute(CREATE_ROUTING_TOPOLOGY_NODES_INDEXES_SQL)
        conn.execute(POPULATE_TOPOLOGY_NODES_SQL)
        conn.execute(CREATE_ROUTING_EDGES_VIEW_SQL)
        conn.commit()
