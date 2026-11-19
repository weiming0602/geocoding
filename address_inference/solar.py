"""Footprints that are solar arrays, not buildings (owner, 2026-11-19: 271 Cathance Road, Topsham -- "the shed like
was actually solar panels ... please don't see it as building again").

FEMA's footprints come from imagery and trace ground-mounted panels as "buildings" (both of 271's arrays are
"Single Family Dwelling"). Two signatures, measured per footprint from NAIP (public domain) and the lidar roof:
  low structure: lidar finds roof over less than LOW_COVER of the outline (panels stand 1-3 m and tilt) and the
    photo is not a roof (NDVI > NDVI_MIN) -- 2e3dfcb8, a 21 x 3.8 m row with 5 m2 of lidar roof. The long thin shape
    alone is not enough: Topsham's mobile homes have it too (42 of 67 such strips are E911 houses).
  tracker: a plain square SIDE_MIN..SIDE_MAX m, filling its rectangle, dark (brightness < DARK_MAX), NDVI between
    NDVI_MIN and NDVI_MAX (grass under it; not tree cover, which reads 0.3+) -- 2a6190a6, a 7.4 m square on a pole,
    4.6 m high by lidar, brightness 112, NDVI -0.06.
Photo-only rules failed: dark + NDVI ~0 caught 166-260 real houses in Topsham (houses under trees).
Topsham (footprints < 150 m2): low structure 96 flagged / 13 E911 houses, tracker 45 / 5.

Stored in address_inference.footprint_photo (brightness, NDVI per footprint); road order reads the flags
(order.NOT_SOLAR). Usage: python -m address_inference.solar me --town Topsham "dbname=geocoding"
"""
import argparse
import json

import numpy as np
import psycopg
from PIL import Image, ImageDraw

from . import imagery
from .regions import load_region

MAX_M2 = 150
LOW_COVER = 0.15
LOW_H = 3.5          # low structure: lidar must have SEEN something, small and low (no lidar roof = no data,
                     # e.g. mobile homes under trees: 5 of the 7 Topsham houses the first version took)
TRACKER_COVER = 0.9  # a tilted tracker panel covers less than its square; a square house's roof covers it all
NDVI_MIN = -0.15
NDVI_MAX = 0.12
DARK_MAX = 115
SIDE_MIN, SIDE_MAX = 5.0, 9.0
HALF_M, SIZE = 30, 128

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.footprint_photo (
    state_fips TEXT NOT NULL, source_id TEXT NOT NULL,
    brightness REAL, ndvi REAL,
    PRIMARY KEY (state_fips, source_id))
"""
FOOTPRINTS_SQL = """
SELECT s.source_id, ST_Y(s.inner_point), ST_X(s.inner_point), ST_AsGeoJSON(s.geom)
FROM address_inference.structures s
JOIN towns t ON t.state_abbr = %(state)s AND t.name = %(town)s AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = %(fips)s AND s.sqmeters < %(max_m2)s
"""
FLAGS_SQL = """
WITH b AS (
    SELECT s.source_id, s.sqmeters, ST_Transform(s.geom, 26919) g, ST_OrientedEnvelope(ST_Transform(s.geom, 26919)) env,
           p.brightness, p.ndvi, coalesce(l.roof_m2, 0) roof_m2, l.roof_h
    FROM address_inference.structures s
    JOIN towns t ON t.state_abbr = %(state)s AND t.name = %(town)s AND ST_Intersects(t.geom, s.inner_point)
    JOIN address_inference.footprint_photo p ON p.state_fips = s.state_fips AND p.source_id = s.source_id
    LEFT JOIN address_inference.building_lidar l ON l.state_fips = s.state_fips AND l.source_id = s.source_id
    WHERE s.state_fips = %(fips)s AND s.sqmeters < %(max_m2)s
), e AS (
    SELECT *, ST_Distance(ST_PointN(ST_ExteriorRing(env), 1), ST_PointN(ST_ExteriorRing(env), 2)) a,
              ST_Distance(ST_PointN(ST_ExteriorRing(env), 2), ST_PointN(ST_ExteriorRing(env), 3)) c
    FROM b
)
SELECT source_id FROM e
WHERE (roof_m2 > 0 AND roof_m2 / nullif(sqmeters, 0) < %(low_cover)s AND roof_h <= %(low_h)s AND ndvi > %(ndvi_min)s)
   OR (least(a, c) >= %(side_min)s AND greatest(a, c) <= %(side_max)s AND greatest(a, c) / nullif(least(a, c), 0) <= 1.2
       AND ST_Area(g) / nullif(ST_Area(env), 0) >= 0.97 AND ST_NPoints(g) <= 5
       AND roof_m2 > 0 AND roof_m2 / nullif(sqmeters, 0) <= %(tracker_cover)s
       AND brightness < %(dark_max)s AND ndvi > %(ndvi_min)s AND ndvi <= %(ndvi_max)s)
"""


def measure(lat, lon, geojson):
    """(mean brightness of R, G, B; mean NDVI) over one footprint."""
    bbox = imagery.bbox_around(lat, lon, HALF_M)
    x0, y0, x1, y1 = bbox
    to_px = lambda lo, la: ((imagery.merc(lo, la)[0] - x0) / (x1 - x0) * SIZE,
                            (y1 - imagery.merc(lo, la)[1]) / (y1 - y0) * SIZE)
    mask = Image.new("L", (SIZE, SIZE), 0)
    g = json.loads(geojson)
    for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
        ImageDraw.Draw(mask).polygon([to_px(x, y) for x, y in poly[0]], fill=1)
    inside = np.asarray(mask) > 0
    if not inside.any():
        return None, None
    b = [imagery.crop(bbox, SIZE, k).astype(float)[inside] for k in range(4)]
    return float(np.mean((b[0] + b[1] + b[2]) / 3)), float(np.mean((b[3] - b[0]) / (b[3] + b[0] + 1e-6)))


def run(region, town, dsns, progress=lambda m: print(m, flush=True)):
    params = {"state": region.state_abbr, "town": town, "fips": region.state_fips, "max_m2": MAX_M2}
    with psycopg.connect(dsns[0]) as conn:
        rows = conn.execute(FOOTPRINTS_SQL, params).fetchall()
    rows.sort(key=lambda r: (round(r[1], 2), round(r[2], 2)))  # tile-local order
    tiles = sorted({t for _, lat, lon, _ in rows for t in imagery.tiles_for(imagery.bbox_around(lat, lon, HALF_M))})
    imagery.ensure(tiles, bands=(0, 1, 2, 3), progress=lambda k, n: progress(f"  imagery tiles {k}/{n}"))
    out = []
    for i, (sid, lat, lon, gj) in enumerate(rows):
        bright, ndvi = measure(lat, lon, gj)
        if bright is not None:
            out.append((region.state_fips, sid, bright, ndvi))
        if i % 500 == 0:
            progress(f"  {i}/{len(rows)}")
    for dsn in dsns:
        with psycopg.connect(dsn) as conn:
            conn.execute(CREATE_SQL)
            with conn.cursor() as cur:
                cur.executemany("""INSERT INTO address_inference.footprint_photo VALUES (%s, %s, %s, %s)
                                   ON CONFLICT (state_fips, source_id) DO UPDATE
                                   SET brightness = EXCLUDED.brightness, ndvi = EXCLUDED.ndvi""", out)
    return len(out)


def solar_footprints(conn, region_state_abbr, state_fips, town) -> set:
    """Source ids road order should not count as buildings (empty when footprint_photo isn't loaded)."""
    if conn.execute("SELECT to_regclass('address_inference.footprint_photo') IS NULL").fetchone()[0]:
        return set()
    return {r[0] for r in conn.execute(FLAGS_SQL, {
        "state": region_state_abbr, "town": town, "fips": state_fips, "max_m2": MAX_M2, "low_cover": LOW_COVER,
        "ndvi_min": NDVI_MIN, "ndvi_max": NDVI_MAX, "dark_max": DARK_MAX, "side_min": SIDE_MIN,
        "side_max": SIDE_MAX, "low_h": LOW_H, "tracker_cover": TRACKER_COVER})}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("region")
    p.add_argument("--town", required=True)
    p.add_argument("dsns", nargs="+")
    a = p.parse_args()
    print(run(load_region(a.region), a.town, a.dsns), "footprints measured")


if __name__ == "__main__":
    main()
