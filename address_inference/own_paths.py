"""Two homes on one tax lot, each with its own way to the road (owner, 2026-11-25, 104/106 Maquoit Drive).

driveways.py traces each building's cheapest path to a road over NAIP. A roof reads as pavement there, so a second
house's path ran straight over the first house's roof and both driveways came out at the same entry. Here every
pair of dwellings (structures.prim_occ in order.HOME_CLASSES, >= MIN_M2) sharing a lot is traced again with every
other building's roof blocked; a dwelling whose path runs its own way (more than NEAR_PX from the other's path) for
at least APART_M and APART_SHARE of its length has its own way in.

    python -m address_inference.own_paths me --town Freeport "dbname=geocoding"

Writes address_inference.lot_own_paths (state_fips, source_id, other_id, path_m, apart_m) per traced pair; order.py
(LOT_OWN_PATH) makes both of a pair separate places when either runs apart.
"""
import argparse
import time
from collections import defaultdict
from multiprocessing import Pool

import numpy as np
import psycopg
from PIL import Image, ImageDraw
from scipy.ndimage import binary_dilation
from skimage.graph import MCP_Geometric

from . import imagery
from . import driveways as dw
from .regions import load_region

MIN_M2 = 40.0
HALF_M = 120
SIZE = 512  # ~0.47 m pixels
NEAR_PX = 4
WORKERS = 10
HOME_CLASSES = ("Single Family Dwelling", "Multi - Family Dwelling", "Manufactured Home")

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.lot_own_paths (
  state_fips text NOT NULL, source_id text NOT NULL, other_id text NOT NULL,
  path_m real, apart_m real, paved_apart_m real, join_road_m real, PRIMARY KEY (state_fips, source_id, other_id))
"""
PAIRS_SQL = """
SELECT bp.parcel_id, s.source_id, ST_Y(s.inner_point), ST_X(s.inner_point), ST_AsGeoJSON(s.geom)
FROM address_inference.building_parcels bp
JOIN address_inference.structures s ON s.source_id = bp.source_id AND s.state_fips = bp.state_fips
JOIN towns t ON t.state_abbr = %(state)s AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, s.inner_point)
WHERE bp.state_fips = %(state_fips)s AND s.prim_occ = ANY(%(classes)s) AND s.sqmeters >= %(min_m2)s
"""
ROOFS_SQL = """
SELECT ST_AsGeoJSON(geom) FROM address_inference.structures
WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326), 0.002)
"""


def trace_lot(conn, homes):
    """homes: [(source_id, lat, lon, geojson)] on one lot -> [(sid, other, path_m, apart_m)] for every ordered pair."""
    old = dw.SIZE
    dw.SIZE = SIZE  # driveways' cost map and hidden-driveway search read the crop size from the module
    try:
        return _trace_lot(conn, homes)
    finally:
        dw.SIZE = old


def _trace_lot(conn, homes):
    lat = sum(h[1] for h in homes) / len(homes)
    lon = sum(h[2] for h in homes) / len(homes)
    bbox = imagery.bbox_around(lat, lon, HALF_M)
    x0, y0, x1, y1 = bbox

    def to_px(lo, la):
        mx, my = imagery.merc(lo, la)
        return (mx - x0) / (x1 - x0) * SIZE, (y1 - my) / (y1 - y0) * SIZE
    px_m = 2 * HALF_M / SIZE
    cost, ndvi = dw.cost_map(bbox, with_ndvi=True)
    roads_img, roofs_img = Image.new("L", (SIZE, SIZE), 0), Image.new("L", (SIZE, SIZE), 0)
    for _name, geo in conn.execute(dw.ROADS_SQL, {"lat": lat, "lon": lon}).fetchall():
        for line in dw._lines(geo):
            ImageDraw.Draw(roads_img).line([to_px(x, y) for x, y in line], fill=1, width=3)
    for (geo,) in conn.execute(ROOFS_SQL, {"lat": lat, "lon": lon}).fetchall():
        for ring in dw._rings(geo):
            ImageDraw.Draw(roofs_img).polygon([to_px(x, y) for x, y in ring], fill=1, outline=1)
    roads, roofs = np.asarray(roads_img) > 0, np.asarray(roofs_img) > 0
    if not roads.any():
        return []
    rim = binary_dilation(roads, iterations=2)
    paths = {}
    for sid, _la, _lo, geo in homes:
        h = Image.new("L", (SIZE, SIZE), 0)
        for ring in dw._rings(geo):
            ImageDraw.Draw(h).polygon([to_px(x, y) for x, y in ring], fill=1, outline=1)
        inside = np.asarray(h) > 0
        if not inside.any():
            continue
        cst = cost.copy()
        cst[dw.hidden_driveway(cst, ndvi, inside, roads)] = dw.HIDDEN_COST
        cst[roofs & ~inside] = np.inf  # never through another building
        cst[inside] = 1.0
        mcp = MCP_Geometric(cst)
        cum, _ = mcp.find_costs([tuple(p) for p in np.argwhere(inside)])
        if not np.isfinite(cum[rim]).any():
            continue
        r, c = np.argwhere(rim)[np.argmin(cum[rim])]
        path = np.asarray(mcp.traceback((int(r), int(c))))  # from the house to the road
        out_of_house = ~inside[path[:, 0], path[:, 1]]
        paths[sid] = (path[out_of_house], cst[path[out_of_house, 0], path[out_of_house, 1]] <= dw.HIDDEN_COST)
    out = []
    for a, (pa, paved) in paths.items():
        for b, (pb, _pv) in paths.items():
            if a == b or not len(pa):
                continue
            m = np.zeros((SIZE, SIZE), dtype=bool)
            m[pb[:, 0], pb[:, 1]] = True
            near = binary_dilation(m, iterations=NEAR_PX)[pa[:, 0], pa[:, 1]]
            # where a's way meets b's (first pixel near it, walking from a's house), and how far that is from the road
            j = int(np.argmax(near)) if near.any() else len(pa)
            apart = ~near[:j]
            out.append((a, b, float(len(pa) * px_m), float(apart.sum() * px_m),
                        float((apart & paved[:j]).sum() * px_m), float((len(pa) - j) * px_m)))
    return out


_conn = []


def _init(dsn):
    _conn[:] = [psycopg.connect(dsn)]


def _work(homes):
    try:
        return trace_lot(_conn[0], homes)
    except Exception as e:  # one bad lot never stops the town
        return [("error", str(e), 0.0, 0.0, 0.0, 0.0)]


def run(region, town, dsn, workers=WORKERS):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_SQL)
        by_lot = defaultdict(list)
        for pid, sid, lat, lon, geo in conn.execute(PAIRS_SQL, {
                "state": region.state_abbr, "town": town, "state_fips": region.state_fips,
                "classes": list(HOME_CLASSES), "min_m2": MIN_M2}).fetchall():
            by_lot[pid].append((sid, lat, lon, geo))
        lots = [h for h in by_lot.values() if 2 <= len(h) <= 4]
        sids = [h[0] for hs in lots for h in hs]
        conn.execute("DELETE FROM address_inference.lot_own_paths WHERE state_fips = %s AND source_id = ANY(%s)",
                     (region.state_fips, sids))
        conn.commit()
    tiles = set()
    for hs in lots:
        tiles.update(imagery.tiles_for(imagery.bbox_around(hs[0][1], hs[0][2], HALF_M)))
    imagery.ensure(sorted(tiles))
    t0, rows, errors = time.time(), [], 0
    with Pool(workers, initializer=_init, initargs=(dsn,)) as pool:
        for i, res in enumerate(pool.imap_unordered(_work, lots, chunksize=4)):
            for r in res:
                if r[0] == "error":
                    errors += 1
                else:
                    rows.append(r)
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(lots)} lots ({time.time() - t0:.0f} s)", flush=True)
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO address_inference.lot_own_paths VALUES (%s, %s, %s, %s, %s, %s, %s) "
                            "ON CONFLICT DO NOTHING", [(region.state_fips,) + r for r in rows])
        conn.commit()
    print(f"{town}: {len(lots)} lots with 2-4 dwellings, {len(rows)} traced pairs, {errors} errors", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("region")
    ap.add_argument("dsn")
    ap.add_argument("--town", required=True)
    a = ap.parse_args()
    run(load_region(a.region), a.town, a.dsn)


if __name__ == "__main__":
    main()
