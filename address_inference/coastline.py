"""Census TIGER/Line coastline, for the coastal-street rules.

    python -m address_inference.coastline "dbname=geocoding" me tl_2025_us_coastline.shp \
        --areawater tl_2025_23005_areawater.shp

Some dead-end roads run down to the water with deep lots on either side
(Freeport's Brickyard Cove), and those lots are numbered in columns along
the road -- where each lot meets the road -- not by where their houses
sit. order.load_positions applies that only on dead ends that stop near
the coast, using this table.

Sources (US Census Bureau TIGER/Line, public domain like the streets):
  - "Coastline" national file -- but it traces only the outer ocean edge
    (for Freeport, 10.5 km out past the Casco Bay islands):
    https://www2.census.gov/geo/tiger/TIGER2025/COASTLINE/tl_2025_us_coastline.zip
  - "Area Hydrography" (AREAWATER) per county: the outlines of its bays,
    estuaries and sounds (MTFCC H2051) and ocean (H2053) are the real
    shoreline, coves included, e.g. for Cumberland County:
    https://www2.census.gov/geo/tiger/TIGER2025/AREAWATER/tl_2025_23005_areawater.zip
Only features inside the region's bounding box are kept.
"""

import argparse

import psycopg
import shapefile

from .regions import load_region

SEA_MTFCC = {"H2051", "H2053"}

# Rough bounding boxes (lon/lat) of regions with a coast.
REGION_BOXES = {"me": (-71.2, 42.9, -66.8, 47.5)}

CREATE_SQL = """
CREATE SCHEMA IF NOT EXISTS address_inference;
CREATE TABLE IF NOT EXISTS address_inference.coastline (
    id SERIAL PRIMARY KEY,
    region_id TEXT NOT NULL,
    name TEXT,
    geom geometry(LineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_coastline_geom ON address_inference.coastline USING GIST (geom);
"""


def lines_in_box(path, box):
    west, south, east, north = box
    reader = shapefile.Reader(path)
    for sr in reader.iterShapeRecords():
        shape = sr.shape
        parts = list(shape.parts) + [len(shape.points)]
        for start, end in zip(parts, parts[1:]):
            pts = shape.points[start:end]
            if len(pts) < 2:
                continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            if max(xs) < west or min(xs) > east or max(ys) < south or min(ys) > north:
                continue
            yield sr.record["NAME"] or None, "LINESTRING(" + ",".join(f"{x} {y}" for x, y in pts) + ")"


def sea_shores(path, box):
    """Outline rings of an AREAWATER file's bay/estuary/ocean polygons."""
    west, south, east, north = box
    reader = shapefile.Reader(path)
    for sr in reader.iterShapeRecords():
        if sr.record["MTFCC"] not in SEA_MTFCC:
            continue
        shape = sr.shape
        parts = list(shape.parts) + [len(shape.points)]
        for start, end in zip(parts, parts[1:]):
            pts = shape.points[start:end]
            if len(pts) < 2:
                continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            if max(xs) < west or min(xs) > east or max(ys) < south or min(ys) > north:
                continue
            yield sr.record["FULLNAME"] or sr.record["MTFCC"], "LINESTRING(" + ",".join(f"{x} {y}" for x, y in pts) + ")"


def load(dsn, region, path, areawater=()) -> int:
    box = REGION_BOXES.get(region.id)
    if box is None:
        raise SystemExit(f"no coastline box for region {region.id!r}")
    rows = list(lines_in_box(path, box))
    for aw in areawater:
        rows += list(sea_shores(aw, box))
    with psycopg.connect(dsn) as conn:
        for statement in filter(str.strip, CREATE_SQL.split(";")):
            conn.execute(statement)
        conn.execute("DELETE FROM address_inference.coastline WHERE region_id = %s", (region.id,))
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO address_inference.coastline (region_id, name, geom) "
                "VALUES (%s, %s, ST_SetSRID(ST_GeomFromText(%s), 4326))",
                [(region.id, name, wkt) for name, wkt in rows])
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn")
    parser.add_argument("region")
    parser.add_argument("shapefile")
    parser.add_argument("--areawater", nargs="*", default=[],
                        help="county AREAWATER shapefiles: their bay/ocean outlines are the inner shoreline")
    args = parser.parse_args()
    n = load(args.dsn, load_region(args.region), args.shapefile, args.areawater)
    print(f"{n} coastline lines loaded")


if __name__ == "__main__":
    main()
