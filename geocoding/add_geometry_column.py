"""One-off: turns streets.geometry (WKT TEXT) into a real SpatiaLite
geometry column so the table is recognized as a spatial layer by GIS
tools (QGIS, etc.). Requires mod_spatialite (bundled with QGIS) on PATH.

Usage: python -m geocoding.add_geometry_column [db_path]
"""

import os
import sqlite3
import sys
import time
from pathlib import Path

MOD_SPATIALITE_DIR = r"C:\Program Files\QGIS 3.44.12\bin"
DEFAULT_DB_PATH = r"C:\software\database\sqlite3\geocoding.sqlite"


def add_geometry_column(db_path: Path) -> None:
    os.environ["PATH"] = MOD_SPATIALITE_DIR + ";" + os.environ["PATH"]

    conn = sqlite3.connect(db_path)
    conn.enable_load_extension(True)
    conn.load_extension("mod_spatialite")

    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "spatial_ref_sys" not in tables:
        print("initializing SpatiaLite metadata...")
        t0 = time.time()
        conn.execute("SELECT InitSpatialMetaData(1)")
        print(f"  done in {time.time() - t0:.1f}s")

    existing_geom_cols = {
        row[0]
        for row in conn.execute(
            "SELECT f_geometry_column FROM geometry_columns WHERE f_table_name = 'streets'"
        )
    }
    if "geom" not in existing_geom_cols:
        print("adding geom column...")
        conn.execute("SELECT AddGeometryColumn('streets', 'geom', 4326, 'LINESTRING', 'XY')")

    print("populating geom from WKT geometry column...")
    t0 = time.time()
    cursor = conn.execute(
        "UPDATE streets SET geom = GeomFromText(geometry, 4326) WHERE geometry IS NOT NULL AND geom IS NULL"
    )
    conn.commit()
    print(f"  updated {cursor.rowcount} rows in {time.time() - t0:.1f}s")

    print("building spatial index...")
    t0 = time.time()
    conn.execute("SELECT CreateSpatialIndex('streets', 'geom')")
    conn.commit()
    print(f"  done in {time.time() - t0:.1f}s")

    total = conn.execute("SELECT COUNT(*) FROM streets").fetchone()[0]
    with_geom = conn.execute("SELECT COUNT(*) FROM streets WHERE geom IS NOT NULL").fetchone()[0]
    print(f"streets: {with_geom}/{total} rows have geom")

    conn.close()


if __name__ == "__main__":
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(DEFAULT_DB_PATH)
    add_geometry_column(db_path)
