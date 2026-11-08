"""Each building's roof as USGS lidar sees it (3DEP, public domain; DATA_SOURCES.md §8).

Footprints are traced from aerial photos, so a roof under trees is cut
short: 42 Flying Point Road's house comes out a thin 78 m2 strip, while the
lidar sees a 173 m2 roof 6 m up -- bigger and taller than the 186 m2
(outline) / 134 m2 (lidar) outbuilding behind it. The laser goes through
trees to the ground in places, but never through a roof.

    python -m address_inference.lidar me --town Freeport "dbname=geocoding" [more DSNs]

Reads USGS's Entwine Point Tile copies on AWS Open Data
(s3://usgs-lidar-public, one octree per project), caching every file it
fetches under data/lidar/ (git-ignored). Maine's points are classified
only ground / not ground, so roofs are found here: a 1 m cell is roof when
at least ROOF_MIN_HITS last returns stop ROOF_MIN_H..ROOF_MAX_H above the
ground and none reaches the ground. A building's roof is every roof patch
its outline touches (grown by TOUCH_PX).

Writes address_inference.building_lidar (state_fips, source_id, roof_m2,
roof_h): roof area in m2 and median height above ground in m; both NULL
where no lidar covers the building, roof_m2 0 where lidar sees no roof.
"""

import argparse
import io
import json
import math
import multiprocessing
import os
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import psycopg
from PIL import Image, ImageDraw
from scipy.interpolate import griddata
from scipy.ndimage import binary_dilation, binary_opening, label

from .regions import load_region

BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/"
# Projects covering the towns run so far; a tile is read from the first one
# with ground under it (Freeport: South Coastal 2020, flown 2020-05-23).
PROJECTS = ("ME_SouthCoastal_1_2020", "ME_SouthCoastal_2_2020", "ME_SouthCentral_1_B22")
ROOT = Path(os.environ.get("LIDAR_CACHE_DIR", Path(__file__).resolve().parents[1] / "data" / "lidar"))
USER_AGENT = "MeridianGeocoding/1.0 (+https://www.meridiangeocoding.com)"
TILE_M = 250.0       # ground meters per work tile
PAD_M = 30.0         # read this far past a tile, so a roof crossing its edge is whole
ROOF_MIN_HITS = 2
ROOF_MIN_H, ROOF_MAX_H = 2.0, 25.0
TOUCH_PX = 1
WORKERS = max(1, min(12, (os.cpu_count() or 2) - 2))
FETCH_THREADS = 16    # parallel downloads inside each process

BUILDINGS_SQL = """
SELECT s.source_id, ST_Y(s.inner_point), ST_X(s.inner_point), ST_AsGeoJSON(ST_Transform(s.geom, 3857))
FROM address_inference.structures s
JOIN towns t ON t.name = %(town)s AND t.state_abbr = %(state)s AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = %(state_fips)s
ORDER BY s.source_id
"""

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.building_lidar (
    state_fips TEXT NOT NULL,
    source_id TEXT NOT NULL,
    roof_m2 REAL,
    roof_h REAL,
    PRIMARY KEY (state_fips, source_id)
)
"""


def _fetch(project, rel):
    """Bytes of one EPT file, from the local cache or AWS."""
    path = ROOT / project / rel
    if path.exists():
        return path.read_bytes()
    # Ride out a dropped connection (~10 min of retries) instead of losing the run.
    for attempt in range(14):
        try:
            req = urllib.request.Request(f"{BASE}{project}/{rel}", headers={"User-Agent": USER_AGENT})
            data = urllib.request.urlopen(req, timeout=120).read()
            break
        except Exception:
            if attempt == 13:
                raise
            time.sleep(min(60, 2 ** attempt))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}")
    tmp.write_bytes(data)
    tmp.replace(path)
    return data


def read_points(project, xmin, ymin, xmax, ymax):
    """(x, y, z, class, return_number, number_of_returns) rows of `project`
    inside the EPSG:3857 box; empty when the project doesn't cover it.
    Walks the octree's index first, then downloads the data files it needs
    FETCH_THREADS at a time (the work is waiting on the network, not CPU)."""
    import laspy
    meta = json.loads(_fetch(project, "ept.json"))
    b = meta["bounds"]
    if b[0] > xmax or b[3] < xmin or b[1] > ymax or b[4] < ymin:
        return np.zeros((0, 6))
    hier, keys = {}, []
    stack = [(0, 0, 0, 0, "0-0-0-0")]
    while stack:
        d, x, y, z, hkey = stack.pop()
        key = f"{d}-{x}-{y}-{z}"
        if hkey not in hier:
            hier[hkey] = json.loads(_fetch(project, f"ept-hierarchy/{hkey}.json"))
        count = hier[hkey].get(key)
        if count is None:
            continue
        if count == -1:
            hkey = key
            hier[key] = json.loads(_fetch(project, f"ept-hierarchy/{key}.json"))
            count = hier[key].get(key, 0)
        n = 2 ** d
        sx, sy = (b[3] - b[0]) / n, (b[4] - b[1]) / n
        x0, y0 = b[0] + x * sx, b[1] + y * sy
        if x0 > xmax or x0 + sx < xmin or y0 > ymax or y0 + sy < ymin:
            continue
        if count > 0:
            keys.append(key)
        stack.extend((d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz, hkey)
                     for dx in (0, 1) for dy in (0, 1) for dz in (0, 1))

    def points(key):
        las = laspy.read(io.BytesIO(_fetch(project, f"ept-data/{key}.laz")))
        px, py = np.asarray(las.x), np.asarray(las.y)
        m = (px >= xmin) & (px <= xmax) & (py >= ymin) & (py <= ymax)
        return np.column_stack([px[m], py[m], np.asarray(las.z)[m], np.asarray(las.classification)[m],
                                np.asarray(las.return_number)[m], np.asarray(las.number_of_returns)[m]])

    with ThreadPoolExecutor(FETCH_THREADS) as ex:
        out = [a for a in ex.map(points, keys) if len(a)]
    return np.vstack(out) if out else np.zeros((0, 6))


def roof_grid(pts, k, x0, y1, nx, ny):
    """(roof mask, height grid) on 1 m cells; `k` turns 3857 units into
    ground meters, (x0, y1) is the grid's top-left in scaled units."""
    x, y, z, cls, rn, nr = (pts[:, i] for i in range(6))
    x, y = x / k, y / k
    col, row = np.floor(x - x0).astype(int), np.floor(y1 - y).astype(int)
    ok = (col >= 0) & (col < nx) & (row >= 0) & (row < ny)
    ground = cls == 2
    if ground.sum() < 3:
        return None, None
    gz = griddata((x[ground], y[ground]), z[ground], (x, y), method="linear")
    hole = np.isnan(gz)
    if hole.any():
        gz[hole] = griddata((x[ground], y[ground]), z[ground], (x[hole], y[hole]), method="nearest")
    hag = z - gz
    last = ok & (rn == nr) & ~ground & (cls != 7) & (cls != 18) & (hag > ROOF_MIN_H) & (hag < ROOF_MAX_H)
    g = ok & ground
    hits, seen = np.zeros((ny, nx)), np.zeros((ny, nx))
    hsum = np.zeros((ny, nx))
    np.add.at(hits, (row[last], col[last]), 1)
    np.add.at(hsum, (row[last], col[last]), hag[last])
    np.add.at(seen, (row[g], col[g]), 1)
    roof = binary_opening((hits >= ROOF_MIN_HITS) & (seen == 0), iterations=1)
    return roof, np.where(hits > 0, hsum / np.maximum(hits, 1), np.nan)


def _outline_mask(geojson, k, x0, y1, nx, ny):
    m = Image.new("L", (nx, ny), 0)
    g = json.loads(geojson)
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    for poly in polys:
        ImageDraw.Draw(m).polygon([(px / k - x0, y1 - py / k) for px, py in poly[0]], fill=1, outline=1)
    return np.asarray(m) > 0


def measure_tile(job):
    """[(source_id, roof_m2, roof_h)] for one tile's buildings; saved under
    data/lidar/tiles/ so a rerun skips finished tiles."""
    (tx, ty), k, buildings = job
    done = ROOT / "tiles" / f"{tx}_{ty}.json"
    ids = sorted(b[0] for b in buildings)
    if done.exists():
        saved = json.loads(done.read_text())
        if sorted(r[0] for r in saved) == ids:
            return [tuple(r) for r in saved]
    out = _measure_tile(tx, ty, k, buildings)
    done.parent.mkdir(parents=True, exist_ok=True)
    done.write_text(json.dumps(out))
    return out


def _measure_tile(tx, ty, k, buildings):
    x0, y1 = tx * TILE_M - PAD_M, (ty + 1) * TILE_M + PAD_M
    n = int(TILE_M + 2 * PAD_M)
    box = (x0 * k, (y1 - n) * k, (x0 + n) * k, y1 * k)
    pts = np.zeros((0, 6))
    for project in PROJECTS:
        pts = read_points(project, *box)
        if (pts[:, 3] == 2).sum() > 100:
            break
    roof, height = roof_grid(pts, k, x0, y1, n, n) if len(pts) else (None, None)
    if roof is None:
        return [(sid, None, None) for sid, *_ in buildings]
    patches, _ = label(roof)
    out = []
    for sid, _lat, _lon, geo in buildings:
        inside = binary_dilation(_outline_mask(geo, k, x0, y1, n, n), iterations=TOUCH_PX)
        ids = set(np.unique(patches[inside & roof]).tolist()) - {0}
        blob = np.isin(patches, list(ids)) if ids else np.zeros_like(roof)
        out.append((sid, float(blob.sum()), float(np.nanmedian(height[blob])) if blob.any() else None))
    return out


def run(region, town, dsns, progress=lambda m: print(m, flush=True), workers=None):
    params = {"town": town, "state": region.state_abbr, "state_fips": region.state_fips}
    with psycopg.connect(dsns[0]) as conn:
        buildings = conn.execute(BUILDINGS_SQL, params).fetchall()
    # One Mercator scale for the whole town: a per-building scale shifts
    # the scaled coordinates by hundreds of meters between buildings.
    k = 1 / math.cos(math.radians(sum(b[1] for b in buildings) / len(buildings)))
    tiles = defaultdict(list)
    for b in buildings:
        sid, lat, lon, geo = b
        mx = lon * 20037508.34 / 180
        my = math.log(math.tan((90 + lat) * math.pi / 360)) * 20037508.34 / math.pi
        tiles[(math.floor(mx / k / TILE_M), math.floor(my / k / TILE_M))].append(b)
    jobs = [(t, k, bs) for t, bs in sorted(tiles.items())]
    progress(f"{town}: {len(buildings)} buildings in {len(jobs)} tiles")
    t0, rows = time.time(), []
    with multiprocessing.get_context("fork").Pool(workers or WORKERS) as pool:
        for i, part in enumerate(pool.imap_unordered(measure_tile, jobs), 1):
            rows.extend((region.state_fips, *r) for r in part)
            if i % 10 == 0 or i == len(jobs):
                progress(f"  {i}/{len(jobs)} tiles ({time.time() - t0:.0f} s)")
    for dsn in dsns:
        with psycopg.connect(dsn) as conn:
            conn.execute(CREATE_SQL)
            conn.execute("DELETE FROM address_inference.building_lidar WHERE state_fips = %s AND source_id = ANY(%s)",
                         (region.state_fips, [r[1] for r in rows]))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO address_inference.building_lidar VALUES (%s, %s, %s, %s)", rows)
        progress(f"{dsn}: {len(rows)} buildings")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("--workers", type=int, help=f"parallel processes (default {WORKERS})")
    parser.add_argument("dsns", nargs="+")
    args = parser.parse_args()
    run(load_region(args.region), args.town, args.dsns, workers=args.workers)


if __name__ == "__main__":
    main()
