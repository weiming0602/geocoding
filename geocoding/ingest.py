"""Ingest a TIGER/Line edges shapefile into Postgres.

TIGER/Line edges (tl_<year>_<statecounty>_edges.shp) carry per-side
address ranges and ZIP codes, which is what makes house-number
interpolation geocoding possible later on. The edges layer also
includes non-road features (rail, hydrography, boundaries); only rows
with a road MTFCC (codes starting with "S") are kept.
"""

import argparse
from pathlib import Path
from typing import Optional

import psycopg
import shapefile

from .db import insert_ignore_count
from .schema import CREATE_INDEXES_SQL, CREATE_TABLE_SQL

# Maps TIGER/Line field names to our column names.
FIELD_MAP = {
    "TLID": "tlid",
    "FULLNAME": "fullname",
    "LFROMADD": "lfromadd",
    "LTOADD": "ltoadd",
    "RFROMADD": "rfromadd",
    "RTOADD": "rtoadd",
    "ZIPL": "zipl",
    "ZIPR": "zipr",
    "MTFCC": "mtfcc",
    "STATEFP": "statefp",
    "COUNTYFP": "countyfp",
}


def _shape_to_wkt(shape) -> Optional[str]:
    if not shape.points:
        return None
    part_starts = list(shape.parts) + [len(shape.points)]
    parts = []
    for start, end in zip(part_starts, part_starts[1:]):
        coords = ", ".join(f"{x} {y}" for x, y in shape.points[start:end])
        parts.append(f"({coords})")
    if len(parts) == 1:
        return f"LINESTRING {parts[0]}"
    return f"MULTILINESTRING ({', '.join(parts)})"


def ingest(shp_path: Path, dsn: str) -> int:
    """Ingest one edges shapefile into the database at dsn, creating tables
    as needed.

    Rows are keyed by TLID (TIGER/Line ID, unique nationwide), so
    re-ingesting a file already loaded — or one that overlaps an
    already-loaded county — silently skips rows that exist already
    instead of duplicating or erroring. Returns the number of rows
    newly inserted (not the number read from the shapefile).
    """
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_TABLE_SQL)
        # Indexes (including the unique index on tlid) must exist before
        # inserting so "ON CONFLICT (tlid)" can actually detect duplicates.
        conn.execute(CREATE_INDEXES_SQL)

        reader = shapefile.Reader(str(shp_path))
        field_names = [f[0] for f in reader.fields[1:]]  # skip the deletion flag
        available = [name for name in FIELD_MAP if name in field_names]
        missing = [name for name in FIELD_MAP if name not in field_names]
        if missing:
            print(f"warning: fields not in shapefile, will be left NULL: {missing}")

        # geom is populated straight from the same WKT as geometry -- no
        # separate SpatiaLite-style backfill pass needed on Postgres.
        columns = ["geometry", "minx", "miny", "maxx", "maxy", "geom"]
        columns += [FIELD_MAP[name] for name in available]
        value_exprs = ["%s", "%s", "%s", "%s", "%s", "ST_GeomFromText(%s, 4326)"]
        value_exprs += ["%s" for _ in available]
        insert_sql = (
            f"INSERT INTO streets ({', '.join(columns)}) "
            f"VALUES ({', '.join(value_exprs)}) "
            "ON CONFLICT (tlid) DO NOTHING RETURNING id"
        )

        rows = []
        for shape_record in reader.iterShapeRecords():
            shape = shape_record.shape
            record = shape_record.record.as_dict()
            # TIGER/Line edges cover every linear feature (roads, rail,
            # hydrography, boundaries, ...), not just streets. MTFCC codes
            # starting with "S" are roads; skip everything else.
            if "MTFCC" in available and not (record.get("MTFCC") or "").startswith("S"):
                continue
            wkt = _shape_to_wkt(shape)
            bbox = list(shape.bbox) if shape.points else [None, None, None, None]
            row = [wkt, *bbox, wkt, *(record.get(name) for name in available)]
            rows.append(row)

        count = insert_ignore_count(conn, insert_sql, rows)
        conn.commit()
        return count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest a TIGER/Line edges shapefile into Postgres."
    )
    parser.add_argument(
        "shapefile", type=Path, help="Path to .shp (matching .dbf/.shx must sit alongside it)"
    )
    parser.add_argument("dsn", help="Postgres connection string, e.g. 'dbname=geocoding'")
    args = parser.parse_args()

    count = ingest(args.shapefile, args.dsn)
    print(f"Inserted {count} new street edges into {args.dsn}")


if __name__ == "__main__":
    main()
