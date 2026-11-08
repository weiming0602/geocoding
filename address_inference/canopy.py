"""Trees over and around each building, from NAIP imagery (DATA_SOURCES.md §7).

Footprints are traced from aerial imagery, so trees over a roof cut the
outline short: 42 Flying Point Road's house comes out a thin 78 m2 strip,
a third of it under leaves. A building whose outline is tree-covered or
thin has an unreliable size -- road order shouldn't call it a shed for
being small, and the ranker gets these measures as inputs.

    python -m address_inference.canopy me --town Freeport "dbname=geocoding" [more DSNs]

Writes address_inference.building_canopy (state_fips, source_id,
canopy_over, canopy_ring, width_m) in every DSN given:
canopy_over: share of the outline that is vegetation (NDVI > TREE_NDVI);
canopy_ring: the same in a RING_M band around it; width_m: the short side
of its oriented bounding box.
"""

import argparse
import time

import numpy as np
import psycopg
from PIL import Image, ImageDraw
from scipy.ndimage import binary_dilation

from . import imagery
from .driveways import _rings
from .regions import load_region

TREE_NDVI = 0.3   # leaves (lawn and fields sit lower in late-summer NAIP)
RING_M = 4        # band around the outline
HALF_M = 30       # crop half-width around each building
SIZE = 180        # crop pixels (~0.33 m each)

BUILDINGS_SQL = """
SELECT s.source_id, ST_Y(s.inner_point), ST_X(s.inner_point), ST_AsGeoJSON(s.geom),
       (SELECT min(ST_Length(ST_MakeLine(ST_PointN(r, i), ST_PointN(r, i + 1))))
          FROM (SELECT ST_ExteriorRing(ST_OrientedEnvelope(ST_Transform(s.geom, 26919))) AS r) e,
               generate_series(1, 2) i)
FROM address_inference.structures s
JOIN towns t ON t.name = %(town)s AND t.state_abbr = %(state)s AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = %(state_fips)s
ORDER BY s.source_id
"""

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.building_canopy (
    state_fips TEXT NOT NULL,
    source_id TEXT NOT NULL,
    canopy_over REAL,
    canopy_ring REAL,
    width_m REAL,
    PRIMARY KEY (state_fips, source_id)
)
"""


def measure(lat, lon, geojson):
    """(canopy_over, canopy_ring) for one building."""
    bbox = imagery.bbox_around(lat, lon, HALF_M)
    x0, y0, x1, y1 = bbox
    to_px = lambda lo, la: ((imagery.merc(lo, la)[0] - x0) / (x1 - x0) * SIZE,
                            (y1 - imagery.merc(lo, la)[1]) / (y1 - y0) * SIZE)
    red, nir = imagery.crop(bbox, SIZE, 0), imagery.crop(bbox, SIZE, 3)
    tree = (nir - red) / (nir + red + 1e-6) > TREE_NDVI
    mask = Image.new("L", (SIZE, SIZE), 0)
    for ring in _rings(geojson):
        ImageDraw.Draw(mask).polygon([to_px(x, y) for x, y in ring], fill=1, outline=1)
    inside = np.asarray(mask) > 0
    if not inside.any():
        return None, None
    band = binary_dilation(inside, iterations=max(1, round(RING_M / (2 * HALF_M / SIZE)))) & ~inside
    return float(tree[inside].mean()), float(tree[band].mean()) if band.any() else None


def run(region, town, dsns, progress=lambda m: print(m, flush=True)):
    params = {"town": town, "state": region.state_abbr, "state_fips": region.state_fips}
    with psycopg.connect(dsns[0]) as conn:
        buildings = conn.execute(BUILDINGS_SQL, params).fetchall()
    progress(f"{town}: {len(buildings)} buildings")
    tiles = [t for _, lat, lon, _, _ in buildings for t in imagery.tiles_for(imagery.bbox_around(lat, lon, HALF_M))]
    fetched = imagery.ensure(tiles, progress=lambda k, n: progress(f"  imagery tiles {k}/{n}"))
    progress(f"imagery: {len(set(tiles))} tiles, {fetched} downloaded")
    t0 = time.time()
    # Tile order, so the in-memory tile cache keeps hitting.
    buildings.sort(key=lambda b: (imagery.tiles_for(imagery.bbox_around(b[1], b[2], 0))[0], b[0]))
    rows = []
    for k, (sid, lat, lon, geo, width) in enumerate(buildings, 1):
        over, ring = measure(lat, lon, geo)
        rows.append((region.state_fips, sid, over, ring, width))
        if k % 1000 == 0:
            progress(f"  {k}/{len(buildings)} ({time.time() - t0:.0f} s)")
    for dsn in dsns:
        with psycopg.connect(dsn) as conn:
            conn.execute(CREATE_SQL)
            conn.execute("DELETE FROM address_inference.building_canopy WHERE state_fips = %s AND source_id = ANY(%s)",
                         (region.state_fips, [r[1] for r in rows]))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO address_inference.building_canopy VALUES (%s, %s, %s, %s, %s)", rows)
        progress(f"{dsn}: {len(rows)} buildings")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("dsns", nargs="+")
    args = parser.parse_args()
    run(load_region(args.region), args.town, args.dsns)


if __name__ == "__main__":
    main()
