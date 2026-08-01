"""One-off / re-runnable: turns streets.geometry (WKT TEXT) into a real
SpatiaLite geometry column so the table is recognized as a spatial layer
by GIS tools (QGIS, etc.). Requires mod_spatialite (bundled with QGIS)
on PATH.

Deliberately does NOT rely on SpatiaLite's own maintenance triggers:
AddGeometryColumn() creates triggers (ggi_*, gii_*, tmi_*, ...) that
validate/index `geom` on every write to `streets` -- but ingest.py's
ordinary INSERTs don't load mod_spatialite, so those triggers fail with
"no such function: GeometryConstraints". This script drops them right
after creating them and instead treats geom/spatial-index maintenance as
an explicit step you re-run after ingesting more data (idempotent: only
backfills rows where geom IS NULL, and recovers rather than rebuilds the
spatial index when one already exists).

Usage: python -m geocoding.add_geometry_column [db_path]
"""

import os
import sqlite3
import sys
import time
from pathlib import Path

MOD_SPATIALITE_DIR = r"C:\Program Files\QGIS 3.44.12\bin"
DEFAULT_DB_PATH = r"C:\software\database\sqlite3\geocoding.sqlite"

# Created by AddGeometryColumn(); see the module docstring for why they're
# incompatible with ingest.py's plain (no-extension-loaded) connections.
_TRIGGERS_TO_DROP = [
    "ggi_streets_geom",
    "ggu_streets_geom",
    "tmi_streets_geom",
    "tmu_streets_geom",
    "tmd_streets_geom",
    "gii_streets_geom",
    "giu_streets_geom",
    "gid_streets_geom",
]


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

    existing = conn.execute(
        "SELECT spatial_index_enabled FROM geometry_columns WHERE f_table_name = 'streets'"
    ).fetchone()
    if existing is None:
        print("adding geom column...")
        conn.execute("SELECT AddGeometryColumn('streets', 'geom', 4326, 'LINESTRING', 'XY')")
        conn.commit()

        existing_triggers = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='streets'"
            )
        }
        for trigger in _TRIGGERS_TO_DROP:
            if trigger in existing_triggers:
                conn.execute(f'DROP TRIGGER "{trigger}"')
        conn.commit()
        index_already_built = False
    else:
        index_already_built = bool(existing[0])

    print("populating geom from WKT geometry column...")
    t0 = time.time()
    cursor = conn.execute(
        "UPDATE streets SET geom = GeomFromText(geometry, 4326) WHERE geometry IS NOT NULL AND geom IS NULL"
    )
    conn.commit()
    print(f"  updated {cursor.rowcount} rows in {time.time() - t0:.1f}s")

    t0 = time.time()
    if index_already_built:
        print("recovering spatial index (syncing newly-populated rows)...")
        conn.execute("SELECT RecoverSpatialIndex('streets', 'geom')")
    else:
        print("building spatial index...")
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
