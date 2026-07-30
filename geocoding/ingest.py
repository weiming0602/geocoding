"""Ingest a TIGER/Line edges shapefile into a SQLite database.

TIGER/Line edges (tl_<year>_<statecounty>_edges.shp) carry per-side
address ranges and ZIP codes, which is what makes house-number
interpolation geocoding possible later on.
"""

import argparse
import sqlite3
from pathlib import Path
from typing import Optional

import shapefile

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


def ingest(shp_path: Path, db_path: Path) -> int:
    """Ingest one edges shapefile into db_path, creating tables as needed."""
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(CREATE_TABLE_SQL)

        reader = shapefile.Reader(str(shp_path))
        field_names = [f[0] for f in reader.fields[1:]]  # skip the deletion flag
        available = [name for name in FIELD_MAP if name in field_names]
        missing = [name for name in FIELD_MAP if name not in field_names]
        if missing:
            print(f"warning: fields not in shapefile, will be left NULL: {missing}")

        columns = ["geometry", "minx", "miny", "maxx", "maxy"]
        columns += [FIELD_MAP[name] for name in available]
        placeholders = ", ".join("?" for _ in columns)
        insert_sql = (
            f"INSERT INTO streets ({', '.join(columns)}) "
            f"VALUES ({placeholders})"
        )

        rows = []
        for shape_record in reader.iterShapeRecords():
            shape = shape_record.shape
            record = shape_record.record.as_dict()
            wkt = _shape_to_wkt(shape)
            bbox = list(shape.bbox) if shape.points else [None, None, None, None]
            row = [wkt, *bbox, *(record.get(name) for name in available)]
            rows.append(row)

        conn.executemany(insert_sql, rows)
        conn.executescript(CREATE_INDEXES_SQL)
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest a TIGER/Line edges shapefile into a SQLite database."
    )
    parser.add_argument(
        "shapefile", type=Path, help="Path to .shp (matching .dbf/.shx must sit alongside it)"
    )
    parser.add_argument("database", type=Path, help="Path to the output SQLite database")
    args = parser.parse_args()

    count = ingest(args.shapefile, args.database)
    print(f"Ingested {count} street edges into {args.database}")


if __name__ == "__main__":
    main()
