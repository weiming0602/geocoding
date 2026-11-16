"""Street survey, step 1 (owner, 2026-11-16): before assigning any numbers, load every layer
for a street and look at its layout -- then decide which pattern to number it by.

Layers per street (all already in the database or the imagery cache):
- centerline: TIGER pieces + drive extensions merged into one line (street_lines)
- buildings within BUFFER_M: footprint, m2, lidar roof, tax lot, nearest other building,
  tree cover, the imagery-traced driveway (road, entry, meters off pavement)
- tax lots touching the buffer (shape only -- never the tax roll's numbers)
- OSM drives and foot paths/trails (internal only, ODbL)
- vegetation: NDVI from the cached NAIP imagery over the street's box
- street numbers: E911's number list (an input); E911 points are kept only for
  review/scoring, never for deciding anything

Usage: python -m address_inference.survey "dbname=geocoding" me --town Harpswell \
           --street "BAYVIEW ROAD" --png data/survey/bayview.png
"""
import argparse
from dataclasses import dataclass, field

import numpy as np
import psycopg
from shapely import wkb

from . import imagery
from .regions import load_region
from .street_lines import street_lines

BUFFER_M = 250
TREE_NDVI = 0.3   # canopy.TREE_NDVI
NDVI_PX_M = 2.0   # vegetation raster resolution (meters per pixel)


@dataclass
class StreetLayers:
    town: str
    street: str
    line: object                      # shapely LineString (lon/lat)
    buildings: list = field(default_factory=list)   # dicts
    lots: list = field(default_factory=list)        # (parcel_id, shapely geom)
    drives: list = field(default_factory=list)      # (osm_id, name, highway, service, geom)
    trails: list = field(default_factory=list)      # (osm_id, name, highway, geom)
    numbers: list = field(default_factory=list)     # sorted distinct street numbers (input)
    e911: list = field(default_factory=list)        # (number, lon, lat) -- review/scoring only
    ndvi: object = None                             # 2-D array over bbox_merc
    bbox_merc: tuple = None


BUILDINGS_SQL = f"""
WITH l AS (SELECT g FROM street_lines WHERE street = %(street)s)
SELECT s.source_id, ST_AsBinary(s.geom), ST_X(s.inner_point), ST_Y(s.inner_point), s.sqmeters, s.occ_cls,
       ST_Distance(s.inner_point::geography, l.g::geography) AS dist_m,
       ST_LineLocatePoint(l.g, s.inner_point) * ST_Length(l.g::geography) AS along_m,
       bl.roof_m2, bl.roof_h, bp.parcel_id, bc.canopy_over,
       (SELECT min(ST_Distance(s.geom::geography, o.geom::geography)) FROM address_inference.structures o
         WHERE o.state_fips = s.state_fips AND o.source_id != s.source_id
           AND o.geom && ST_Expand(s.geom, 0.003)) AS nearest_other_m
FROM l JOIN address_inference.structures s
  ON s.state_fips = %(state_fips)s AND s.inner_point && ST_Expand(l.g, 0.004)
 AND ST_DWithin(s.inner_point::geography, l.g::geography, {BUFFER_M})
LEFT JOIN address_inference.building_lidar bl ON bl.state_fips = s.state_fips AND bl.source_id = s.source_id
LEFT JOIN address_inference.building_parcels bp ON bp.state_fips = s.state_fips AND bp.source_id = s.source_id
LEFT JOIN address_inference.building_canopy bc ON bc.state_fips = s.state_fips AND bc.source_id = s.source_id
ORDER BY along_m
"""

DRIVEWAYS_SQL = """
SELECT source_id, road, off_m, entry_lon, entry_lat FROM address_inference.building_driveways
WHERE state_fips = %(state_fips)s AND source_id = ANY(%(ids)s)
"""

AREA = f"(SELECT ST_Buffer(g::geography, {BUFFER_M})::geometry AS a FROM street_lines WHERE street = %(street)s)"
LOTS_SQL = f"""SELECT p.parcel_id, ST_AsBinary(p.geom) FROM address_inference.parcels p, {AREA} b
WHERE p.state_fips = %(state_fips)s AND p.geom && b.a AND ST_Intersects(p.geom, b.a)"""
DRIVES_SQL = f"""SELECT d.osm_id, d.name, d.highway, d.service, ST_AsBinary(d.geom) FROM address_inference.osm_drives d, {AREA} b
WHERE d.town = %(town)s AND d.geom && b.a AND ST_Intersects(d.geom, b.a)"""
TRAILS_SQL = f"""SELECT t.osm_id, t.name, t.highway, ST_AsBinary(t.geom) FROM address_inference.osm_paths t, {AREA} b
WHERE t.town = %(town)s AND t.geom && b.a AND ST_Intersects(t.geom, b.a)"""
E911_SQL = """SELECT address_number, ST_X(geom), ST_Y(geom) FROM public.address_points
WHERE upper(town) = upper(%(town)s) AND upper(street_fullname) = %(street)s AND address_number IS NOT NULL"""


def load(dsn, region, town, street, vegetation=True) -> StreetLayers:
    params = {"region": region.id, "town": town, "state_fips": region.state_fips, "street": street}
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        row = conn.execute("SELECT ST_AsBinary(g) FROM street_lines WHERE street = %(street)s", params).fetchone()
        if row is None:
            raise ValueError(f"{street!r} has no matched line in {town}")
        out = StreetLayers(town, street, wkb.loads(bytes(row[0])))
        for (sid, g, lon, lat, m2, occ, dist, along, roof, roof_h, pid, canopy, nearest) in conn.execute(BUILDINGS_SQL, params):
            out.buildings.append(dict(source_id=sid, geom=wkb.loads(bytes(g)), lon=lon, lat=lat, m2=m2, occ=occ,
                                      dist_m=dist, along_m=along, roof_m2=roof, roof_h=roof_h, parcel_id=pid,
                                      canopy=canopy, nearest_other_m=nearest, driveways=[]))
        by_id = {b["source_id"]: b for b in out.buildings}
        if conn.execute("SELECT to_regclass('address_inference.building_driveways') IS NOT NULL").fetchone()[0]:
            for sid, road, off, elon, elat in conn.execute(DRIVEWAYS_SQL, {**params, "ids": list(by_id)}):
                by_id[sid]["driveways"].append(dict(road=road, off_m=off, entry=(elon, elat)))
        out.lots = [(pid, wkb.loads(bytes(g))) for pid, g in conn.execute(LOTS_SQL, params)]
        out.drives = [(i, n, h, s, wkb.loads(bytes(g))) for i, n, h, s, g in conn.execute(DRIVES_SQL, params)]
        out.trails = [(i, n, h, wkb.loads(bytes(g))) for i, n, h, g in conn.execute(TRAILS_SQL, params)]
        out.e911 = [(n, x, y) for n, x, y in conn.execute(E911_SQL, params)]
    out.numbers = sorted({n for n, _, _ in out.e911})
    if vegetation:
        lon0, lat0, lon1, lat1 = out.line.buffer(BUFFER_M / 111000).bounds
        (x0, y0), (x1, y1) = imagery.merc(lon0, lat0), imagery.merc(lon1, lat1)
        size = int(min(1600, max(200, (x1 - x0) / NDVI_PX_M)))
        bbox = (x0, y0, x1, y1)
        imagery.ensure(imagery.tiles_for(bbox))
        red, nir = imagery.crop(bbox, size, 0), imagery.crop(bbox, size, 3)
        out.ndvi, out.bbox_merc = (nir - red) / (nir + red + 1e-6), bbox
    return out


def render(s: StreetLayers, png: str, labels: dict | None = None, zoom: tuple | None = None) -> None:
    """One picture with every layer (Web Mercator). labels: {source_id: text} to write on buildings.
    zoom: (lo, hi) meters along the centerline -- frame only that stretch."""
    from .street_names import canonical
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def xy(geom):
        if geom.geom_type.startswith("Multi") or geom.geom_type == "GeometryCollection":
            return [xy(g) for g in geom.geoms]
        coords = geom.exterior.coords if geom.geom_type == "Polygon" else geom.coords
        pts = [imagery.merc(x, y) for x, y in coords]
        return [p[0] for p in pts], [p[1] for p in pts]

    def draw(geom, **kw):
        res = xy(geom)
        for xs, ys in (res if isinstance(res, list) else [res]):
            ax.plot(xs, ys, **kw)

    fig, ax = plt.subplots(figsize=(12, 12))
    if s.ndvi is not None:
        x0, y0, x1, y1 = s.bbox_merc
        ax.imshow(np.where(s.ndvi > TREE_NDVI, 1.0, np.nan), extent=(x0, x1, y0, y1), cmap="Greens",
                  vmin=0, vmax=1.6, alpha=0.6, interpolation="nearest")
    for _pid, g in s.lots:
        draw(g, color="#999999", lw=0.6, ls=":")
    for _i, _n, _h, _s, g in s.drives:
        draw(g, color="#c47f00", lw=1.5)
    for _i, _n, _h, g in s.trails:
        draw(g, color="#8a2be2", lw=1.0, ls="--")
    draw(s.line, color="black", lw=2.5)
    for b in s.buildings:
        alone = (b["nearest_other_m"] or 0) >= 100
        res = xy(b["geom"])
        for xs, ys in (res if isinstance(res, list) else [res]):
            ax.fill(xs, ys, color="#d62728" if alone else "#1f77b4", alpha=0.8)
        for d in b["driveways"]:
            if d["road"] != canonical(s.street):
                continue  # a driveway to another road
            if d["entry"][0] is not None and d["off_m"] is not None and d["off_m"] <= 10:
                ex, ey = imagery.merc(*d["entry"])
                bx, by = imagery.merc(b["lon"], b["lat"])
                ax.plot([bx, ex], [by, ey], color="#555555", lw=0.8)
        if labels and b["source_id"] in labels:
            bx, by = imagery.merc(b["lon"], b["lat"])
            ax.annotate(labels[b["source_id"]], (bx, by), fontsize=7)
    for n, x, y in s.e911:
        ex, ey = imagery.merc(x, y)
        ax.plot(ex, ey, "k+", ms=5)
        ax.annotate(str(n), (ex, ey), fontsize=6, color="#333333", xytext=(3, 3), textcoords="offset points")
    # frame: the street's corridor (or the zoomed stretch), not every lot that touches it
    if zoom:
        pts = [imagery.merc(b["lon"], b["lat"]) for b in s.buildings if zoom[0] <= b["along_m"] <= zoom[1]]
        pad = 60
    else:
        x0, y0, x1, y1 = s.line.buffer(BUFFER_M / 111000).bounds
        pts = [imagery.merc(x0, y0), imagery.merc(x1, y1)]
        pad = 0
    if pts:
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        ax.set_xlim(min(xs) - pad, max(xs) + pad); ax.set_ylim(min(ys) - pad, max(ys) + pad)
    ax.set_aspect("equal"); ax.set_xticks([]); ax.set_yticks([])
    ax.set_title(f"{s.street}, {s.town}: centerline (black), buildings (blue; red = 100 m+ from any other), "
                 f"OSM drives (orange), trails (purple dashed), driveways (grey), lots (dotted), trees (green), "
                 f"E911 numbers (+, review only)", fontsize=8)
    fig.tight_layout()
    fig.savefig(png, dpi=150)
    plt.close(fig)


def summary(s: StreetLayers) -> str:
    alone = sum((b["nearest_other_m"] or 0) >= 100 for b in s.buildings)
    lots = {b["parcel_id"] for b in s.buildings if b["parcel_id"]}
    per_lot = {}
    for b in s.buildings:
        per_lot[b["parcel_id"]] = per_lot.get(b["parcel_id"], 0) + 1
    big = sorted(((n, p) for p, n in per_lot.items() if p), reverse=True)[:3]
    return (f"{s.street} ({s.town}): line {s.line.length * 111000:.0f} m (approx), {len(s.buildings)} buildings "
            f"within {BUFFER_M} m ({alone} stand 100 m+ from any other), {len(lots)} lots (most buildings on one lot: "
            f"{', '.join(f'{n}' for n, _ in big)}), {len(s.drives)} OSM drives, {len(s.trails)} trails, "
            f"{sum(len(b['driveways']) > 0 for b in s.buildings)} traced driveways, {len(s.numbers)} numbers "
            f"({s.numbers[0] if s.numbers else '-'}-{s.numbers[-1] if s.numbers else '-'})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dsn")
    ap.add_argument("region")
    ap.add_argument("--town", required=True)
    ap.add_argument("--street", required=True)
    ap.add_argument("--png")
    ap.add_argument("--no-vegetation", action="store_true")
    ap.add_argument("--zoom", help="lo,hi meters along the centerline to frame")
    args = ap.parse_args()
    s = load(args.dsn, load_region(args.region), args.town, args.street.upper(), vegetation=not args.no_vegetation)
    print(summary(s))
    if args.png:
        render(s, args.png, zoom=tuple(map(float, args.zoom.split(","))) if args.zoom else None)
        print("wrote", args.png)


if __name__ == "__main__":
    main()
