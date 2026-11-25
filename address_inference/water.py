"""How close each building stands to open water, from NAIP imagery (DATA_SOURCES.md §7).

Owner (2026-11-24): where the road runs close to the shore, the house stands toward the water and the garage toward
the road, so road order's "nearer the street wins within a lot" (order.WITHIN_LOT "min_near") must not apply there.
Water = NAIP pixels with NDVI < WATER_NDVI and near-infrared below WATER_NIR (open water is dark in NIR).

    python -m address_inference.water me --town Freeport "dbname=geocoding" [more DSNs]

Writes address_inference.building_water (state_fips, source_id, water_dist_m, water_share): meters from the
building's inner point to the nearest water pixel within HALF_M (NULL = none), and the water share of that square.
"""
import argparse
import time

import numpy as np
import psycopg
from scipy.ndimage import distance_transform_edt, binary_opening, label

from . import imagery
from .regions import load_region

WATER_NDVI = 0.0
WATER_NIR = 60
HALF_M = 100
SIZE = 200        # ~1 m pixels
MIN_BLOB = 2      # opening iterations: drop dark roofs/shadows smaller than a few meters
MIN_WATER_M2 = 2000  # a water body is one connected dark area at least this big (a roof or shadow is not)

BUILDINGS_SQL = """
SELECT s.source_id, ST_Y(s.inner_point), ST_X(s.inner_point)
FROM address_inference.structures s
JOIN towns t ON t.name = %(town)s AND t.state_abbr = %(state)s AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = %(state_fips)s
ORDER BY s.source_id
"""
CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.building_water (
    state_fips TEXT NOT NULL, source_id TEXT NOT NULL, water_dist_m REAL, water_share REAL,
    PRIMARY KEY (state_fips, source_id))
"""


def measure(lat, lon):
    bbox = imagery.bbox_around(lat, lon, HALF_M)
    red, nir = imagery.crop(bbox, SIZE, 0).astype(float), imagery.crop(bbox, SIZE, 3).astype(float)
    water = ((nir - red) / (nir + red + 1e-6) < WATER_NDVI) & (nir < WATER_NIR)
    water = binary_opening(water, iterations=MIN_BLOB)
    px_m2 = (2 * HALF_M / SIZE) ** 2
    lab, n = label(water)
    if n:
        sizes = np.bincount(lab.ravel())
        big = np.nonzero(sizes * px_m2 >= MIN_WATER_M2)[0]
        water = np.isin(lab, big[big > 0])
    if not water.any():
        return None, 0.0
    px_m = 2 * HALF_M / SIZE
    dist = distance_transform_edt(~water) * px_m
    c = SIZE // 2
    return float(dist[c, c]), float(water.mean())


def run(region, town, dsns, progress=lambda m: print(m, flush=True)):
    params = {"town": town, "state": region.state_abbr, "state_fips": region.state_fips}
    with psycopg.connect(dsns[0]) as conn:
        buildings = conn.execute(BUILDINGS_SQL, params).fetchall()
    progress(f"{town}: {len(buildings)} buildings")
    tiles = [t for _, lat, lon in buildings for t in imagery.tiles_for(imagery.bbox_around(lat, lon, HALF_M))]
    imagery.ensure(tiles)
    buildings.sort(key=lambda b: (imagery.tiles_for(imagery.bbox_around(b[1], b[2], 0))[0], b[0]))
    t0, rows = time.time(), []
    for k, (sid, lat, lon) in enumerate(buildings, 1):
        d, share = measure(lat, lon)
        rows.append((region.state_fips, sid, d, share))
        if k % 1000 == 0:
            progress(f"  {k}/{len(buildings)} ({time.time() - t0:.0f} s)")
    for dsn in dsns:
        with psycopg.connect(dsn) as conn:
            conn.execute(CREATE_SQL)
            conn.execute("DELETE FROM address_inference.building_water WHERE state_fips = %s AND source_id = ANY(%s)",
                         (region.state_fips, [r[1] for r in rows]))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO address_inference.building_water VALUES (%s, %s, %s, %s)", rows)
        progress(f"{dsn}: {len(rows)} buildings")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("region")
    p.add_argument("--town", required=True)
    p.add_argument("dsns", nargs="+")
    a = p.parse_args()
    run(load_region(a.region), a.town, a.dsns)


if __name__ == "__main__":
    main()
