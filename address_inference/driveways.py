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
import multiprocessing
import os
import time
from collections import defaultdict

import numpy as np
import psycopg
from PIL import Image, ImageDraw
from scipy.ndimage import binary_dilation, median_filter
from skimage.graph import MCP_Geometric

from . import imagery
from .regions import load_region
from .street_names import canonical

SET_BACK_M = 40      # buildings at least this far from their nearest road...
CORNER_M = 60        # ...or with two named roads within this distance (corners)
HALF_M = 260         # crop half-width (ground meters)
SIZE = 768           # crop pixels (~0.68 m each)
ROAD_RADIUS_M = 300  # candidate roads within this distance of the building
PAVE_NDVI = 0.12
PAVE_BRIGHT = 80
OFF_PAVEMENT_COST = 30.0
VIA_BUFFER_PX = 8      # ~5 m: a path within this of another road "runs along" it
WORKERS = max(1, min(12, (os.cpu_count() or 2) - 2))  # parallel processes
WORKER_TILES = 12      # imagery tiles each process keeps in memory (~12 MB each)
JUNCTION_PX = 22       # ~15 m: a road's own stretch starts this far from any other road
# Branch-road check (48 Flying Point Road: Johns Road branches off the road
# its driveway joins, so it looked nearly as cheap). Right on 48's TIGER
# roads, but town-wide it cost TIGER 0.1 and E911 roads 0.5 points -- off.
BRANCH_CHECK = False

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.building_driveways (
    state_fips TEXT NOT NULL,
    source_id TEXT NOT NULL,
    road TEXT NOT NULL,
    cost REAL NOT NULL,
    entry_lat DOUBLE PRECISION,  -- where the cheapest path meets this road
    entry_lon DOUBLE PRECISION,
    off_m REAL,                  -- meters of that path off pavement
    PRIMARY KEY (state_fips, source_id, road)
);
ALTER TABLE address_inference.building_driveways ADD COLUMN IF NOT EXISTS entry_lat DOUBLE PRECISION;
ALTER TABLE address_inference.building_driveways ADD COLUMN IF NOT EXISTS entry_lon DOUBLE PRECISION;
ALTER TABLE address_inference.building_driveways ADD COLUMN IF NOT EXISTS off_m REAL
"""

SET_BACK_SQL = """
SELECT s.source_id, ST_Y(s.inner_point), ST_X(s.inner_point), ST_AsGeoJSON(s.geom)
FROM address_inference.structures s
JOIN address_inference.building_segments bs
  ON bs.state_fips = s.state_fips AND bs.source = s.source AND bs.source_id = s.source_id AND bs.rank = 1
JOIN towns t ON t.name = %(town)s AND t.state_abbr = %(state)s AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = %(state_fips)s
  AND (bs.dist_m >= %(set_back)s
       -- corner buildings: a second named road within CORNER_M, however close
       -- the first (1 Carriage Road: 30 m from Carriage, 39 m from Flying Point)
       OR (SELECT count(DISTINCT upper(st2.fullname))
             FROM address_inference.building_segments b2 JOIN streets st2 ON st2.tlid = b2.tlid
            WHERE b2.state_fips = s.state_fips AND b2.source = s.source AND b2.source_id = s.source_id
              AND b2.dist_m <= %(corner)s AND coalesce(trim(st2.fullname), '') <> '') >= 2)
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
    return {db: {k: v[0] for k, v in paths.items()}
            for db, paths in road_paths(lat, lon, building_geojson, roads_by_db, quick=True).items()}


def road_paths(lat, lon, building_geojson, roads_by_db, quick=False):
    """{db_index: {canonical road: (cost, entry_lat, entry_lon, off_m)}} -- the
    cheapest path's cost, where it meets the road (the driveway's entry), and
    how many meters of it are off pavement (small = a visible driveway).
    quick: a building with one road in reach gets (1.0, None, None, None)
    without imagery."""
    bbox = imagery.bbox_around(lat, lon, HALF_M)
    x0, y0, x1, y1 = bbox
    to_px = lambda lo, la: ((imagery.merc(lo, la)[0] - x0) / (x1 - x0) * SIZE,
                            (y1 - imagery.merc(lo, la)[1]) / (y1 - y0) * SIZE)

    px_m = 2 * HALF_M / SIZE

    def entry(cumulative, m, tracer=None):
        r, c = np.argwhere(m)[np.argmin(cumulative[m])]
        mx, my = x0 + (c + 0.5) / SIZE * (x1 - x0), y1 - (r + 0.5) / SIZE * (y1 - y0)
        off = None
        if tracer is not None and math.isfinite(float(cumulative[r, c])):
            path = np.asarray(tracer.traceback((int(r), int(c))))
            off = float((cost[path[:, 0], path[:, 1]] > 2).sum() * px_m)
        return (float(cumulative[r, c]),
                math.degrees(2 * math.atan(math.exp(my * math.pi / 20037508.34)) - math.pi / 2),
                mx / 20037508.34 * 180, off)
    # Draw every road first: a building with a single named road in reach
    # has nothing to choose between (its ratio is 1 whatever the cost), so it
    # skips the imagery and path search entirely.
    masks_by_db = {}
    for db, roads in roads_by_db.items():
        masks = {}
        for name, geo in roads:
            key = canonical(name)
            mask = masks.setdefault(key, Image.new("L", (SIZE, SIZE), 0))
            for line in _lines(geo):
                ImageDraw.Draw(mask).line([to_px(x, y) for x, y in line], fill=1, width=3)
        masks = {k: np.asarray(m) > 0 for k, m in masks.items()}
        masks_by_db[db] = {k: m for k, m in masks.items() if m.any()}
    if quick and all(len(m) <= 1 for m in masks_by_db.values()):
        return {db: {k: (1.0, None, None, None) for k in masks} for db, masks in masks_by_db.items()}
    cost = cost_map(bbox)
    house = Image.new("L", (SIZE, SIZE), 0)
    for ring in _rings(building_geojson):
        ImageDraw.Draw(house).polygon([to_px(x, y) for x, y in ring], fill=1, outline=1)
    inside = np.asarray(house) > 0
    starts = np.argwhere(inside)
    if len(starts) == 0:
        return {}
    cost[inside] = 1.0
    start_list = [tuple(p) for p in starts]
    mcp = MCP_Geometric(cost)
    cum, _ = mcp.find_costs(start_list)
    out = {}
    for db, masks in masks_by_db.items():
        best = {}
        if not BRANCH_CHECK:
            out[db] = {key: entry(cum, m, mcp) for key, m in masks.items()}
            continue
        for key, m in masks.items():
            others = np.zeros_like(m)
            for k2, m2 in masks.items():
                if k2 != key:
                    others |= m2
            junction = binary_dilation(others, iterations=JUNCTION_PX)
            others = binary_dilation(others, iterations=VIA_BUFFER_PX)
            # Reaching a road right where it meets another road says nothing
            # about which one the driveway joins: only this road's own stretch
            # (beyond JUNCTION_PX of every other road) counts.
            m = m & ~junction
            if not m.any():
                continue
            end = tuple(np.argwhere(m)[np.argmin(cum[m])])
            path = np.asarray(mcp.traceback(end))
            if others[path[:, 0], path[:, 1]].any():
                # The cheapest way here runs along another road first (48
                # Flying Point Road's driveway reaches Flying Point Road;
                # Johns Road only branches off it), so this road's own access
                # is what it costs without crossing any other road. The search
                # stops at the first pixel of this road it reaches.
                blocked = cost.copy()
                blocked[others] = np.inf
                cum2, _ = MCP_Geometric(blocked).find_costs(start_list, ends=[tuple(p) for p in np.argwhere(m)],
                                                            find_all_ends=False)
                best[key] = entry(cum2, m)
            else:
                best[key] = entry(cum, m, mcp)
        out[db] = {k: v for k, v in best.items() if math.isfinite(v[0])}
    return out


_worker_conns: list = []


def _worker_init(dsns):
    imagery.MAX_TILES = WORKER_TILES
    _worker_conns[:] = [psycopg.connect(d) for d in dsns]


def _worker(item):
    sid, (lat, lon, geo) = item
    roads_by_db = {i: c.execute(ROADS_SQL, {"lat": lat, "lon": lon}).fetchall() for i, c in enumerate(_worker_conns)}
    return sid, road_paths(lat, lon, geo, roads_by_db)


def run(region, town, dsns, progress=lambda m: print(m, flush=True), skip_done=False, workers=None):
    workers = workers or WORKERS
    params = {"town": town, "state": region.state_abbr, "state_fips": region.state_fips, "set_back": SET_BACK_M,
              "corner": CORNER_M}
    conns = [psycopg.connect(d) for d in dsns]
    try:
        buildings = {}
        for conn in conns:
            for sid, lat, lon, geo in conn.execute(SET_BACK_SQL, params).fetchall():
                buildings[sid] = (lat, lon, geo)
        if skip_done:
            done = set()
            for conn in conns:
                if not conn.execute("SELECT to_regclass('address_inference.building_driveways') IS NULL").fetchone()[0]:
                    have = {r[0] for r in conn.execute("SELECT DISTINCT source_id FROM address_inference.building_driveways")}
                    done = have if not done else done & have
            buildings = {k: v for k, v in buildings.items() if k not in done}
        progress(f"{town}: {len(buildings)} set-back or corner buildings to do")
        tiles = [t for lat, lon, _ in buildings.values() for t in imagery.tiles_for(imagery.bbox_around(lat, lon, HALF_M))]
        t0 = time.time()
        fetched = imagery.ensure(tiles, progress=lambda k, n: progress(f"  imagery tiles {k}/{n}"))
        progress(f"imagery: {len(set(tiles))} tiles, {fetched} downloaded ({time.time() - t0:.0f} s)")
        rows = defaultdict(list)
        t0 = time.time()
        # Buildings in imagery-tile order, so each worker keeps reusing the
        # few tiles it has loaded.
        items = sorted(buildings.items(), key=lambda kv: (imagery.tiles_for(imagery.bbox_around(kv[1][0], kv[1][1], 0))[0], kv[0]))
        with multiprocessing.get_context("fork").Pool(workers, _worker_init, (dsns,)) as pool:
            for k, (sid, costs_by_db) in enumerate(pool.imap_unordered(_worker, items, chunksize=8), 1):
                for i, costs in costs_by_db.items():
                    rows[i] += [(region.state_fips, sid, road, c, la, lo, off) for road, (c, la, lo, off) in costs.items()]
                if k % 250 == 0:
                    progress(f"  {k}/{len(buildings)} buildings ({time.time() - t0:.0f} s)")
        for i, conn in enumerate(conns):
            for stmt in CREATE_SQL.split(";"):
                conn.execute(stmt)
            conn.execute("DELETE FROM address_inference.building_driveways WHERE state_fips = %s AND source_id = ANY(%s)",
                         (region.state_fips, list(buildings)))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO address_inference.building_driveways (state_fips, source_id, road, cost,"
                                " entry_lat, entry_lon, off_m) VALUES (%s, %s, %s, %s, %s, %s, %s)", rows[i])
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
    parser.add_argument("--skip-done", action="store_true", help="only buildings with no driveway results yet")
    parser.add_argument("--workers", type=int, help=f"parallel processes (default {WORKERS})")
    args = parser.parse_args()
    run(load_region(args.region), args.town, args.dsns, skip_done=args.skip_done, workers=args.workers)


if __name__ == "__main__":
    main()
