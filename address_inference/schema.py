"""Tables for the address_inference schema. Never read by geocoding-server."""

import re

CREATE_SCHEMA_SQL = "CREATE SCHEMA IF NOT EXISTS address_inference"

# Building footprints from any footprint source, in one shape. List-
# partitioned by state so loading/refreshing one state never touches
# another's rows (see ensure_structures_partition).
CREATE_STRUCTURES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.structures (
    state_fips TEXT NOT NULL,
    county_fips TEXT,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    occ_cls TEXT,
    prim_occ TEXT,
    outbldg TEXT,
    sqmeters DOUBLE PRECISION,
    val_method TEXT,
    image_date DATE,
    prod_date DATE,
    geom geometry(MultiPolygon, 4326) NOT NULL,
    -- ST_PointOnSurface, not the centroid: always inside the footprint,
    -- even for an L- or U-shaped building.
    inner_point geometry(Point, 4326) NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (state_fips, source, source_id)
) PARTITION BY LIST (state_fips)
"""

CREATE_STRUCTURES_INDEXES_SQL = """
CREATE INDEX IF NOT EXISTS idx_ai_structures_geom ON address_inference.structures USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_ai_structures_inner_point ON address_inference.structures USING GIST (inner_point);
CREATE INDEX IF NOT EXISTS idx_ai_structures_county ON address_inference.structures (county_fips);
"""


def ensure_structures_tables(conn, state_fips: str) -> None:
    """Creates the schema, the partitioned parent table, its indexes, and
    the one partition for `state_fips`. Safe to call repeatedly."""
    if not re.fullmatch(r"\d{2}", state_fips):
        # It's interpolated into DDL (partition name + bound) below.
        raise ValueError(f"state_fips must be two digits, got {state_fips!r}")
    conn.execute(CREATE_SCHEMA_SQL)
    conn.execute(CREATE_STRUCTURES_TABLE_SQL)
    conn.execute(CREATE_STRUCTURES_INDEXES_SQL)
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS address_inference.structures_{state_fips} "
        f"PARTITION OF address_inference.structures FOR VALUES IN ('{state_fips}')"
    )
