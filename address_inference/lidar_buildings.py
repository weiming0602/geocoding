"""Buildings the footprints missed, found as roofs in USGS lidar (3DEP,
public domain; DATA_SOURCES.md §8).

The FEMA/ORNL footprints (DATA_SOURCES.md §4) are traced from aerial
photos and skip some buildings outright: on Juniper Drive, Freeport, the
mobile homes at E911 1 and 7 are plain in the 2018 photo but have no
outline, so the odd side looked like 4 numbers for 2 houses and no
ordering rule could number it. Here every roof patch lidar.py's roof test
finds (1 m cells where last returns stop 2-25 m up and none reach the
ground) that touches no footprint is a candidate building, kept when it is
house-sized and shaped like a roof rather than a tree crown.

    python -m address_inference.lidar_buildings me --town Freeport "dbname=geocoding" [more DSNs]

Adds them to address_inference.structures with source 'lidar' (source_id
'lidar:<tile x>_<tile y>_<n>'), replacing that town's earlier lidar rows,
so the later stages (attach, parcels, driveways, canopy, lidar) treat them
like any footprint. `--drop` removes them again.
"""

import argparse
import json
import math
import multiprocessing
import time
from collections import defaultdict

import numpy as np
import psycopg
from scipy.ndimage import binary_dilation, label

from . import lidar
from .regions import load_region

SOURCE = "lidar"
# Kept patches: house-sized...
MIN_M2, MAX_M2 = 40.0, 3000.0
# ...filling most of their own minimum rotated rectangle, measured on the
# smoothed outline (roofs are rectangles and L's; crowns are ragged). A
# mobile home lying diagonal to the 1 m grid is a staircase: Juniper Drive's
# house 1 is 0.52 counted in cells...
MIN_FILL = 0.5
# ...at least this tall (a 2 m patch is as likely a hedge or a truck), and
# no taller than this (a dense crown that hides the ground; Juniper's one
# false roof was 12.9 m)...
MIN_H, MAX_H = 2.5, 10.0
# ...showing bare roof in the NAIP photo (imagery.py, DATA_SOURCES.md §7)
# over at least this share of the outline: a cell with NDVI under
# BARE_NDVI. Lidar alone can't tell a dense crown from a roof -- 21 of 21
# finds in 12 random Freeport tiles were trees (bare share 0-0.07), while
# Juniper Drive's missing houses show 0.42-0.78. Juniper's house 7 (0.06,
# under a tree in the 2018 photo) is lost with them...
MIN_BARE, BARE_NDVI = 0.2, 0.05
# ...and with no footprint within this many meters (a patch beside an
# outline is usually that building's roof overhang or a porch).
CLEAR_M = 2

TOWN_SQL = """
SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e), ST_AsGeoJSON(ST_Transform(t.geom, 3857)), ST_Y(ST_Centroid(t.geom))
FROM towns t, LATERAL (SELECT ST_Transform(t.geom, 3857) AS e) x
WHERE t.name = %(town)s AND t.state_abbr = %(state)s
"""

# Only tiles holding an E911 address point: a missing house matters where
# something is numbered (Freeport's whole bounding box is 3,796 tiles,
# mostly water and woods; ~6 h).
POINTS_SQL = """
SELECT ST_X(geom), ST_Y(geom) FROM address_points WHERE town = %(town)s
"""

FOOTPRINTS_SQL = """
SELECT ST_AsGeoJSON(ST_Transform(geom, 3857))
FROM address_inference.structures
WHERE state_fips = %(state_fips)s AND source <> %(source)s
  AND geom && ST_Transform(ST_MakeEnvelope(%(x0)s, %(y0)s, %(x1)s, %(y1)s, 3857), 4326)
"""


def _polygon_mask(geojson, k, x0, y1, nx, ny):
    """lidar._outline_mask for Polygon and MultiPolygon alike."""
    return lidar._outline_mask(geojson, k, x0, y1, nx, ny)


def patch_polygon(cells, k, x0, y1):
    """The patch's 1 m cells (row, col arrays) as one EPSG:3857 polygon."""
    from shapely.geometry import box
    from shapely.ops import unary_union
    squares = [box((x0 + c) * k, (y1 - r - 1) * k, (x0 + c + 1) * k, (y1 - r) * k) for r, c in zip(*cells)]
    shape = unary_union(squares).simplify(0.7 * k)
    if shape.geom_type == "MultiPolygon":
        shape = max(shape.geoms, key=lambda g: g.area)
    return shape


def bare_share(shape):
    """Share of the EPSG:3857 polygon's NAIP pixels with NDVI < BARE_NDVI."""
    from PIL import Image, ImageDraw
    from . import imagery
    x0, y0, x1, y1 = shape.bounds
    bbox = (x0 - 3, y0 - 3, x1 + 3, y1 + 3)
    imagery.ensure(imagery.tiles_for(bbox), bands=(0, 3))
    size = max(8, int((bbox[2] - bbox[0]) / 0.6))
    red, nir = imagery.crop(bbox, size, 0), imagery.crop(bbox, size, 3)
    mask = Image.new("L", (size, size), 0)
    sx, sy = size / (bbox[2] - bbox[0]), size / (bbox[3] - bbox[1])
    ImageDraw.Draw(mask).polygon([((x - bbox[0]) * sx, (bbox[3] - y) * sy) for x, y in shape.exterior.coords], fill=1)
    inside = np.asarray(mask) > 0
    if not inside.any():
        return 0.0
    ndvi = (nir - red) / (nir + red + 1e-6)
    return float((ndvi[inside] < BARE_NDVI).mean())


def keep_patch(area_m2, fill, height_m):
    return (MIN_M2 <= area_m2 <= MAX_M2 and fill >= MIN_FILL and height_m is not None
            and MIN_H <= height_m <= MAX_H)


def _settings():
    return [MIN_M2, MAX_M2, MIN_FILL, MIN_H, MAX_H, CLEAR_M, MIN_BARE, BARE_NDVI, lidar.ROOF_MIN_HITS, lidar.ROOF_MIN_H, lidar.ROOF_MAX_H]


def find_tile(job):
    """find_tile_uncached, saved under data/lidar/untraced/ so a rerun (or a
    run cut off by the network) skips finished tiles; redone when the
    settings or the tile's footprints change."""
    (tx, ty), _k, footprints = job
    done = lidar.ROOT / "untraced" / f"{tx}_{ty}.json"
    key = {"settings": _settings(), "footprints": len(footprints)}
    if done.exists():
        saved = json.loads(done.read_text())
        if saved.get("key") == key:
            return [tuple(r) for r in saved["found"]]
    out = find_tile_uncached(job)
    done.parent.mkdir(parents=True, exist_ok=True)
    done.write_text(json.dumps({"key": key, "found": out}))
    return out


def find_tile_uncached(job):
    """[(tile x, tile y, n, polygon WKT 3857, area m2, median height m, fill)]."""
    (tx, ty), k, footprints = job
    x0, y1 = tx * lidar.TILE_M - lidar.PAD_M, (ty + 1) * lidar.TILE_M + lidar.PAD_M
    n = int(lidar.TILE_M + 2 * lidar.PAD_M)
    bbox = (x0 * k, (y1 - n) * k, (x0 + n) * k, y1 * k)
    pts = np.zeros((0, 6))
    for project in lidar.PROJECTS:
        pts = lidar.read_points(project, *bbox)
        if (pts[:, 3] == 2).sum() > 100:
            break
    roof, height = lidar.roof_grid(pts, k, x0, y1, n, n) if len(pts) else (None, None)
    if roof is None:
        return []
    traced = np.zeros_like(roof)
    for geo in footprints:
        traced |= _polygon_mask(geo, k, x0, y1, n, n)
    near_traced = binary_dilation(traced, iterations=CLEAR_M) if traced.any() else traced
    patches, count = label(roof)
    out = []
    pad = int(lidar.PAD_M)
    for i in range(1, count + 1):
        cells = np.nonzero(patches == i)
        # Each patch belongs to the tile its first cell falls in (the pad is
        # only there so a roof crossing the edge is read whole).
        r0, c0 = cells[0][0], cells[1][0]
        if not (pad <= r0 < n - pad and pad <= c0 < n - pad):
            continue
        if near_traced[cells].any():
            continue
        area = float(len(cells[0]))
        if area < MIN_M2 or area > MAX_M2:
            continue
        shape = patch_polygon(cells, k, x0, y1)
        rect = shape.minimum_rotated_rectangle
        fill = shape.area / rect.area if rect.area else 0.0
        h = float(np.nanmedian(height[cells])) if np.isfinite(height[cells]).any() else None
        if keep_patch(area, fill, h) and bare_share(shape) >= MIN_BARE:
            out.append((tx, ty, i, shape.wkt, area, h, fill))
    return out


def tiles_for_town(conn, region, town):
    row = conn.execute(TOWN_SQL, {"town": town, "state": region.state_abbr}).fetchone()
    if row is None:
        raise SystemExit(f"no town {town!r} in the towns table")
    lat = row[5]
    k = 1 / math.cos(math.radians(lat))
    tiles = set()
    for lon, plat in conn.execute(POINTS_SQL, {"town": town}).fetchall():
        mx = lon * 20037508.34 / 180
        my = math.log(math.tan((90 + plat) * math.pi / 360)) * 20037508.34 / math.pi
        tiles.add((math.floor(mx / k / lidar.TILE_M), math.floor(my / k / lidar.TILE_M)))
    return sorted(tiles), k


INSERT_SQL = """
INSERT INTO address_inference.structures
  (state_fips, county_fips, source, source_id, sqmeters, geom, inner_point)
SELECT %(state_fips)s, NULL, %(source)s, %(source_id)s, %(m2)s, g, ST_PointOnSurface(g)
FROM (SELECT ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromText(%(wkt)s), 3857), 4326)) AS g) x
WHERE EXISTS (SELECT 1 FROM towns t WHERE t.name = %(town)s AND t.state_abbr = %(state)s
              AND ST_Intersects(t.geom, ST_PointOnSurface(x.g)))
"""


def drop(dsn, region, town):
    with psycopg.connect(dsn) as conn:
        n = conn.execute(
            "DELETE FROM address_inference.structures s USING towns t WHERE s.state_fips = %s AND s.source = %s "
            "AND t.name = %s AND t.state_abbr = %s AND ST_Intersects(t.geom, s.inner_point)",
            (region.state_fips, SOURCE, town, region.state_abbr)).rowcount
    return n


def run(region, town, dsns, progress=lambda m: print(m, flush=True), workers=None, tiles=None):
    with psycopg.connect(dsns[0]) as conn:
        all_tiles, k = tiles_for_town(conn, region, town)
        jobs = []
        for tx, ty in (tiles or all_tiles):
            x0, y1 = tx * lidar.TILE_M - lidar.PAD_M, (ty + 1) * lidar.TILE_M + lidar.PAD_M
            size = lidar.TILE_M + 2 * lidar.PAD_M
            fp = [r[0] for r in conn.execute(FOOTPRINTS_SQL, {
                "state_fips": region.state_fips, "source": SOURCE,
                "x0": x0 * k, "y0": (y1 - size) * k, "x1": (x0 + size) * k, "y1": y1 * k}).fetchall()]
            jobs.append(((tx, ty), k, fp))
    progress(f"{town}: {len(jobs)} lidar tiles")
    t0, found = time.time(), []
    with multiprocessing.get_context("fork").Pool(workers or lidar.WORKERS) as pool:
        for i, part in enumerate(pool.imap_unordered(find_tile, jobs), 1):
            found.extend(part)
            if i % 20 == 0 or i == len(jobs):
                progress(f"  {i}/{len(jobs)} tiles, {len(found)} untraced roofs ({time.time() - t0:.0f} s)")
    for dsn in dsns:
        dropped = drop(dsn, region, town)
        kept = 0
        with psycopg.connect(dsn) as conn:
            for tx, ty, i, wkt, area, h, fill in found:
                kept += conn.execute(INSERT_SQL, {
                    "state_fips": region.state_fips, "source": SOURCE, "source_id": f"lidar:{tx}_{ty}_{i}",
                    "m2": area, "wkt": wkt, "town": town, "state": region.state_abbr}).rowcount
        progress(f"{dsn}: replaced {dropped} lidar buildings with {kept} (inside {town})")
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("--workers", type=int)
    parser.add_argument("--drop", action="store_true", help="remove this town's lidar buildings and stop")
    parser.add_argument("dsns", nargs="+")
    args = parser.parse_args()
    region = load_region(args.region)
    if args.drop:
        for dsn in args.dsns:
            print(f"{dsn}: removed {drop(dsn, region, args.town)} lidar buildings")
        return
    run(region, args.town, args.dsns, workers=args.workers)


if __name__ == "__main__":
    main()
