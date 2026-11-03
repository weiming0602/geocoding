"""Stage 1: load building footprints for a region (or part of one).

    python -m address_inference.load_footprints "dbname=geocoding" me --town Freeport
    python -m address_inference.load_footprints "dbname=geocoding" me --county 23005
    python -m address_inference.load_footprints "dbname=geocoding" me          # whole state

--town uses the town's bounding box (from the `towns` table, see
geocoding/ingest_towns.py), so buildings just across the town line are
loaded too -- later stages need the neighbors of edge addresses anyway.
Upserts by (state, source, source id): re-running refreshes rows in place
rather than duplicating them, and only touches this state's partition.
"""

import argparse
import re

import psycopg

from .regions import load_region
from .schema import ensure_structures_tables
from .sources.usa_structures import UsaStructures

UPSERT_SQL = """
INSERT INTO address_inference.structures (
    state_fips, county_fips, source, source_id, occ_cls, prim_occ, outbldg,
    sqmeters, val_method, image_date, prod_date, geom, inner_point, loaded_at
)
SELECT %(state_fips)s, %(county_fips)s, %(source)s, %(source_id)s, %(occ_cls)s,
       %(prim_occ)s, %(outbldg)s, %(sqmeters)s, %(val_method)s, %(image_date)s,
       %(prod_date)s, g.geom, ST_PointOnSurface(g.geom), now()
FROM (
    SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(
        ST_SetSRID(ST_GeomFromGeoJSON(%(geometry)s), 4326)), 3)) AS geom
) g
WHERE NOT ST_IsEmpty(g.geom)
ON CONFLICT (state_fips, source, source_id) DO UPDATE SET
    county_fips = EXCLUDED.county_fips,
    occ_cls = EXCLUDED.occ_cls,
    prim_occ = EXCLUDED.prim_occ,
    outbldg = EXCLUDED.outbldg,
    sqmeters = EXCLUDED.sqmeters,
    val_method = EXCLUDED.val_method,
    image_date = EXCLUDED.image_date,
    prod_date = EXCLUDED.prod_date,
    geom = EXCLUDED.geom,
    inner_point = EXCLUDED.inner_point,
    loaded_at = EXCLUDED.loaded_at
"""


def town_envelope(conn, state_abbr: str, town: str):
    row = conn.execute(
        """SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e)
           FROM (SELECT ST_Extent(geom)::geometry AS e FROM towns
                 WHERE state_abbr = %s AND upper(name) = upper(%s)) t""",
        (state_abbr, town),
    ).fetchone()
    if row is None or row[0] is None:
        raise ValueError(f"town {town!r} not found in towns for {state_abbr} (run geocoding.ingest_towns first)")
    return row


def build_where(state_fips: str, county_fips: str | None) -> str:
    where = f"STATE_FIPS='{state_fips}'"
    if county_fips is not None:
        if not re.fullmatch(rf"{state_fips}\d{{3}}", county_fips):
            raise ValueError(f"county must be a 5-digit FIPS code in state {state_fips}, got {county_fips!r}")
        where += f" AND FIPS='{county_fips}'"
    return where


def load_footprints(dsn, region, town=None, county_fips=None, source=None, progress=print) -> int:
    """Loads one region's footprints (optionally one town's bbox or one
    county). Returns the number of rows written (inserted or refreshed)."""
    if region.footprint_source != "usa_structures":
        raise ValueError(f"no loader for footprint source {region.footprint_source!r}")
    source = source or UsaStructures()
    where = build_where(region.state_fips, county_fips)

    with psycopg.connect(dsn) as conn:
        ensure_structures_tables(conn, region.state_fips)
        conn.commit()
        envelope = town_envelope(conn, region.state_abbr, town) if town else None

        ids = source.object_ids(where, envelope)
        progress(f"{len(ids)} structures to load")
        written = 0
        for rows in source.fetch(ids):
            # The where clause already limits to this state; this guards the
            # partition against a row the service mislabels anyway.
            rows = [{**row, "state_fips": region.state_fips} for row in rows
                    if row["state_fips"] in (None, region.state_fips)]
            if rows:
                with conn.cursor() as cur:
                    cur.executemany(UPSERT_SQL, rows)
                conn.commit()
                written += len(rows)
            progress(f"  {written}/{len(ids)}")
        return written


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn", help="Postgres connection string, e.g. 'dbname=geocoding'")
    parser.add_argument("region", help="region id, e.g. 'me' (address_inference/regions/<id>.toml)")
    area = parser.add_mutually_exclusive_group()
    area.add_argument("--town", help="only this town's bounding box, e.g. Freeport")
    area.add_argument("--county", help="only this county (5-digit FIPS), e.g. 23005")
    args = parser.parse_args()

    count = load_footprints(args.dsn, load_region(args.region), town=args.town, county_fips=args.county)
    print(f"Wrote {count} structures")


if __name__ == "__main__":
    main()
