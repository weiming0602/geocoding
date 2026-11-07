"""Local cache of NAIP aerial imagery (USDA, public domain) from Maine's image service.

The area is split into fixed tiles in Web Mercator (EPSG:3857), TILE_M map
meters on a side (~1 km on the ground in Maine), TILE_PX pixels each (~0.6 m,
NAIP's native resolution). Each tile's bands are downloaded once and kept as
PNGs under data/naip/<service>/ (git-ignored); any crop is then assembled
from the saved tiles -- milliseconds instead of a server round trip.

Bands: 0 red, 1 green, 2 blue, 3 near-infrared. See DATA_SOURCES.md §7.
"""

import io
import math
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

SERVICE = "NAIP/orthoNaip2018"
URL = f"https://gis.maine.gov/image/rest/services/{SERVICE}/ImageServer/exportImage"
ROOT = Path(os.environ.get("NAIP_CACHE_DIR", Path(__file__).resolve().parents[1] / "data" / "naip")) \
    / SERVICE.replace("/", "_")
TILE_M = 1400.0   # map meters (EPSG:3857) per tile side
TILE_PX = 1700    # pixels per tile side
USER_AGENT = "MeridianGeocoding/1.0 (+https://www.meridiangeocoding.com)"


def merc(lon: float, lat: float) -> tuple[float, float]:
    return lon * 20037508.34 / 180, math.log(math.tan((90 + lat) * math.pi / 360)) * 20037508.34 / math.pi


def bbox_around(lat: float, lon: float, half_m: float) -> tuple[float, float, float, float]:
    """EPSG:3857 box reaching half_m ground meters each way from the point."""
    cx, cy = merc(lon, lat)
    h = half_m / math.cos(math.radians(lat))
    return cx - h, cy - h, cx + h, cy + h


def _path(ix: int, iy: int, band: int) -> Path:
    return ROOT / f"{ix}_{iy}_b{band}.png"


def _download(ix: int, iy: int, band: int) -> None:
    x0, y0 = ix * TILE_M, iy * TILE_M
    q = urllib.parse.urlencode({"bbox": f"{x0},{y0},{x0 + TILE_M},{y0 + TILE_M}", "bboxSR": 3857, "imageSR": 3857,
                                "size": f"{TILE_PX},{TILE_PX}", "format": "png", "bandIds": band, "f": "image"})
    for attempt in range(5):
        try:
            req = urllib.request.Request(f"{URL}?{q}", headers={"User-Agent": USER_AGENT})
            data = urllib.request.urlopen(req, timeout=180).read()
            Image.open(io.BytesIO(data)).convert("L").save(_path(ix, iy, band))
            return
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def tiles_for(bbox) -> list[tuple[int, int]]:
    x0, y0, x1, y1 = bbox
    return [(ix, iy) for ix in range(math.floor(x0 / TILE_M), math.floor(x1 / TILE_M) + 1)
            for iy in range(math.floor(y0 / TILE_M), math.floor(y1 / TILE_M) + 1)]


def ensure(tiles, bands=(0, 3), progress=None) -> int:
    """Downloads any missing tile bands, one request at a time (it's a free
    public server); returns how many were fetched."""
    ROOT.mkdir(parents=True, exist_ok=True)
    todo = [(ix, iy, b) for ix, iy in sorted(set(tiles)) for b in bands if not _path(ix, iy, b).exists()]
    for k, (ix, iy, b) in enumerate(todo, 1):
        _download(ix, iy, b)
        if progress and k % 20 == 0:
            progress(k, len(todo))
    return len(todo)


MAX_TILES = 64  # decoded tiles kept in memory (~12 MB each)
_tiles: dict = {}


def _tile(ix: int, iy: int, band: int) -> np.ndarray:
    key = (ix, iy, band)
    if key not in _tiles:
        if len(_tiles) >= MAX_TILES:
            _tiles.clear()
        _tiles[key] = np.asarray(Image.open(_path(ix, iy, band)), dtype=np.float32)
    return _tiles[key]


def crop(bbox, size: int, band: int) -> np.ndarray:
    """The bbox (EPSG:3857 x0, y0, x1, y1) as a size x size float array, from cached tiles."""
    x0, y0, x1, y1 = bbox
    ixs = range(math.floor(x0 / TILE_M), math.floor(x1 / TILE_M) + 1)
    iys = range(math.floor(y0 / TILE_M), math.floor(y1 / TILE_M) + 1)
    # Mosaic of the covering tiles; rows run north (high iy) to south.
    mosaic = np.vstack([np.hstack([_tile(ix, iy, band) for ix in ixs]) for iy in reversed(iys)])
    s = TILE_PX / TILE_M  # pixels per map meter
    mx0, my1 = ixs[0] * TILE_M, (iys[-1] + 1) * TILE_M
    c0, c1 = int(round((x0 - mx0) * s)), int(round((x1 - mx0) * s))
    r0, r1 = int(round((my1 - y1) * s)), int(round((my1 - y0) * s))
    window = mosaic[r0:r1, c0:c1]
    return np.asarray(Image.fromarray(window).resize((size, size), Image.BILINEAR), dtype=np.float32)
