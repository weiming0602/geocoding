"""Which road each set-back building's driveway reaches, from aerial imagery.

    python -m address_inference.driveways me --town Freeport "dbname=geocoding" "dbname=geocoding_osmexp"

No AI model: NAIP (public domain, address_inference.imagery) red + near-
infrared bands -> vegetation index (NDVI) -> a cost map where pavement and
gravel are cheap (not green AND bright -- tree shadows are also low-NDVI but
dark; a 5x5 median wipes out isolated specks while a driveway survives) and
grass/trees are expensive -> the cheapest path from the building's outline
to each nearby named road that carries house numbers. A driveway is a cheap
corridor, so the road it reaches costs least.

Freeport test (947 houses >= 50 m from their E911 street): nearest named
road right 76.7%; this path 78.0%; trusting the path only when the nearest
road costs >= 1.2x more, 79.6%. Here it becomes model input (dataset.py:
drive_ratio, drive_best) so the ranker learns when to trust it.

Writes address_inference.building_driveways (source_id, road = canonical
street name, cost) in each database given -- the roads differ (TIGER vs
other road files), the imagery doesn't, so each building's cost map is
computed once.
"""

import argparse
import json
import math
import time
from collections import defaultdict

import numpy as np
import psycopg
from PIL import Image, ImageDraw
from scipy.ndimage import median_filter
from skimage.graph import MCP_Geometric

from . import imagery
from .regions import load_region
from .street_names import canonical

SET_BACK_M = 40      # only buildings at least this far from their nearest road
HALF_M = 260         # crop half-width (ground meters)
SIZE = 768           # crop pixels (~0.68 m each)
ROAD_RADIUS_M = 300  # candidate roads within this distance of the building
PAVE_NDVI = 0.12
PAVE_BRIGHT = 80
OFF_PAVEMENT_COST = 30.0

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.building_driveways (
    state_fips TEXT NOT NULL,
    source_id TEXT NOT NULL,
    road TEXT NOT NULL,
    cost REAL NOT NULL,
    PRIMARY KEY (state_fips, source_id, road)
)
"""

SET_BACK_SQL = """
SELECT s.source_id, ST_Y(s.inner_point), ST_X(s.inner_point), ST_AsGeoJSON(s.geom)
FROM address_inference.structures s
JOIN address_inference.building_segments bs
  ON bs.state_fips = s.state_fips AND bs.source = s.source AND bs.source_id = s.source_id AND bs.rank = 1
JOIN towns t ON t.name = %(town)s AND t.state_abbr = %(state)s AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = %(state_fips)s AND bs.dist_m >= %(set_back)s
ORDER BY s.source_id
"""

ROADS_SQL = f"""
SELECT st.fullname, ST_AsGeoJSON(st.geom)
FROM streets st
WHERE st.geom && ST_Expand(ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326), 0.004)
  AND ST_DWithin(st.geom::geography, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography, {ROAD_RADIUS_M})
  AND coalesce(trim(st.fullname), '') <> ''
  AND (coalesce(st.lfromadd, '') <> '' OR coalesce(st.rfromadd, '') <> '')
"""


def _lines(geojson):
    g = json.loads(geojson)
    return [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]


def _rings(geojson):
    g = json.loads(geojson)
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    return [ring for poly in polys for ring in poly]


def cost_map(bbox):
    """Per-pixel travel cost: 1 on pavement/gravel, 1 + OFF_PAVEMENT_COST elsewhere."""
    red, nir = imagery.crop(bbox, SIZE, 0), imagery.crop(bbox, SIZE, 3)
    ndvi = (nir - red) / (nir + red + 1e-6)
    pave = median_filter(((ndvi < PAVE_NDVI) & (red > PAVE_BRIGHT)).astype(np.float32), size=5)
    return 1.0 + OFF_PAVEMENT_COST * (1.0 - pave)


def road_costs(lat, lon, building_geojson, roads_by_db):
    """{db_index: {canonical road: cheapest path cost from the building}}."""
    bbox = imagery.bbox_around(lat, lon, HALF_M)
    x0, y0, x1, y1 = bbox
    to_px = lambda lo, la: ((imagery.merc(lo, la)[0] - x0) / (x1 - x0) * SIZE,
                            (y1 - imagery.merc(lo, la)[1]) / (y1 - y0) * SIZE)
    cost = cost_map(bbox)
    house = Image.new("L", (SIZE, SIZE), 0)
    for ring in _rings(building_geojson):
        ImageDraw.Draw(house).polygon([to_px(x, y) for x, y in ring], fill=1, outline=1)
    inside = np.asarray(house) > 0
    starts = np.argwhere(inside)
    if len(starts) == 0:
        return {}
    cost[inside] = 1.0
    cum, _ = MCP_Geometric(cost).find_costs([tuple(p) for p in starts])
    out = {}
    for db, roads in roads_by_db.items():
        best = {}
        for name, geo in roads:
            mask = Image.new("L", (SIZE, SIZE), 0)
            for line in _lines(geo):
                ImageDraw.Draw(mask).line([to_px(x, y) for x, y in line], fill=1, width=3)
            m = np.asarray(mask) > 0
            if m.any():
                c = float(cum[m].min())
                key = canonical(name)
                best[key] = min(best.get(key, math.inf), c)
        out[db] = best
    return out


def run(region, town, dsns, progress=print):
    params = {"town": town, "state": region.state_abbr, "state_fips": region.state_fips, "set_back": SET_BACK_M}
    conns = [psycopg.connect(d) for d in dsns]
    try:
        buildings = {}
        for conn in conns:
            for sid, lat, lon, geo in conn.execute(SET_BACK_SQL, params).fetchall():
                buildings[sid] = (lat, lon, geo)
        progress(f"{town}: {len(buildings)} buildings at least {SET_BACK_M} m from their nearest road")
        tiles = [t for lat, lon, _ in buildings.values() for t in imagery.tiles_for(imagery.bbox_around(lat, lon, HALF_M))]
        t0 = time.time()
        fetched = imagery.ensure(tiles, progress=lambda k, n: progress(f"  imagery tiles {k}/{n}"))
        progress(f"imagery: {len(set(tiles))} tiles, {fetched} downloaded ({time.time() - t0:.0f} s)")
        rows = defaultdict(list)
        t0 = time.time()
        for k, (sid, (lat, lon, geo)) in enumerate(sorted(buildings.items()), 1):
            roads_by_db = {i: c.execute(ROADS_SQL, {"lat": lat, "lon": lon}).fetchall() for i, c in enumerate(conns)}
            for i, costs in road_costs(lat, lon, geo, roads_by_db).items():
                rows[i] += [(region.state_fips, sid, road, c) for road, c in costs.items()]
            if k % 250 == 0:
                progress(f"  {k}/{len(buildings)} buildings ({time.time() - t0:.0f} s)")
        for i, conn in enumerate(conns):
            conn.execute(CREATE_SQL)
            conn.execute("DELETE FROM address_inference.building_driveways WHERE state_fips = %s AND source_id = ANY(%s)",
                         (region.state_fips, list(buildings)))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO address_inference.building_driveways VALUES (%s, %s, %s, %s)", rows[i])
            conn.commit()
            progress(f"{dsns[i]}: {len(rows[i])} building-road costs")
    finally:
        for c in conns:
            c.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("dsns", nargs="+", help="databases whose `streets` define the roads (e.g. TIGER, E911 roads)")
    args = parser.parse_args()
    run(load_region(args.region), args.town, args.dsns)


if __name__ == "__main__":
    main()
