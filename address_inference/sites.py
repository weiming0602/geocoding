"""Campus / institutional site pattern (owner, 2026-11-16, Bowdoin's Schiller Coastal Studies Center on
Bayview Road, Harpswell): a site is numbered as one integrated set, not by distance along the road.

- Site: one tax lot holding SITE_MIN_BUILDINGS+ buildings that the street runs SITE_MIN_INSIDE_M+ into
  (its own drive -- Bayview's campus drive extension runs inside the Bowdoin lot).
- The site's numbers: the street's numbers whose road-start spot (rate_spots) falls on the street's stretch
  inside the lot, give or take SITE_SPOT_MARGIN_M.
- Numbered buildings: house-sized (SITE_MIN_M2+) on the main drive (within SITE_DRIVE_M of the centerline),
  plus any building standing alone (SITE_ALONE_M+ from every other building -- 252's, reached by a trail).
  The served core on its own loop and sheds take no number (the campus address covers the core).
- One number per building in drive order from the entrance; a building past the line's end counts by how
  far past. More numbers than buildings: the numbers whose spot is furthest from any site building stay
  unplaced (220: the campus gate).
Uses only public data (lot shapes, footprints, the centerline with drive extensions) -- never the tax
roll's numbers, never E911.
"""
from collections import defaultdict

import numpy as np
import psycopg

from .street_lines import street_lines

SITES = False  # off until proven on every town
SITE_MIN_BUILDINGS = 8
SITE_MIN_INSIDE_M = 100.0
SITE_SPOT_MARGIN_M = 50.0
SITE_MIN_M2 = 100.0
SITE_DRIVE_M = 40.0
SITE_ALONE_M = 100.0

# Street stretches inside big multi-building lots: (street, parcel, from_m, to_m along the street line).
STRETCHES_SQL = """
WITH big AS (
    SELECT bp.parcel_id FROM address_inference.building_parcels bp
    JOIN address_inference.parcels p ON p.parcel_id = bp.parcel_id AND p.state_fips = bp.state_fips
    WHERE bp.state_fips = %(state_fips)s AND p.town = %(town)s
    GROUP BY bp.parcel_id HAVING count(*) >= %(min_buildings)s
), pieces AS (
    SELECT l.street, p.parcel_id, l.g,
           (ST_Dump(ST_Intersection(l.g, p.geom))).geom AS piece
    FROM street_lines l
    JOIN address_inference.parcels p ON p.geom && l.g AND ST_Intersects(p.geom, l.g)
    JOIN big ON big.parcel_id = p.parcel_id
    WHERE ST_GeometryType(l.g) = 'ST_LineString'
)
SELECT street, parcel_id,
       min(least(ST_LineLocatePoint(g, ST_StartPoint(piece)), ST_LineLocatePoint(g, ST_EndPoint(piece)))) * ST_Length(g::geography),
       max(greatest(ST_LineLocatePoint(g, ST_StartPoint(piece)), ST_LineLocatePoint(g, ST_EndPoint(piece)))) * ST_Length(g::geography),
       sum(ST_Length(piece::geography))
FROM pieces WHERE ST_GeometryType(piece) = 'ST_LineString'
GROUP BY street, parcel_id, g
"""

# The lot's buildings: position along the street (past an end: extended by the distance beyond it),
# distance from the line, size (outline or lidar roof), nearest other building.
BUILDINGS_SQL = """
WITH l AS (SELECT g, ST_Length(g::geography) AS len FROM street_lines WHERE street = %(street)s)
SELECT s.source_id,
       CASE WHEN f = 0 THEN -ST_Distance(s.inner_point::geography, ST_StartPoint(l.g)::geography)
            WHEN f = 1 THEN l.len + ST_Distance(s.inner_point::geography, ST_EndPoint(l.g)::geography)
            ELSE f * l.len END AS along_m,
       ST_Distance(s.inner_point::geography, l.g::geography) AS off_m,
       greatest(s.sqmeters, coalesce(bl.roof_m2, 0)) AS m2,
       (SELECT min(ST_Distance(o.geom::geography, s.geom::geography)) FROM address_inference.structures o
         WHERE o.state_fips = s.state_fips AND o.source_id != s.source_id AND o.geom && ST_Expand(s.geom, 0.003)) AS alone_m
FROM l, address_inference.building_parcels bp
JOIN address_inference.structures s ON s.state_fips = bp.state_fips AND s.source_id = bp.source_id
LEFT JOIN address_inference.building_lidar bl ON bl.state_fips = s.state_fips AND bl.source_id = s.source_id
CROSS JOIN LATERAL (SELECT ST_LineLocatePoint((SELECT g FROM l), s.inner_point) AS f) x
WHERE bp.state_fips = %(state_fips)s AND bp.parcel_id = %(parcel)s
"""


def numbered_buildings(buildings) -> list:
    """[(along_m, source_id)] of the buildings a site numbers, in drive order (along the street)."""
    keep = [(b["along_m"], b["source_id"]) for b in buildings
            if (b["off_m"] <= SITE_DRIVE_M and (b["m2"] or 0) >= SITE_MIN_M2)
            or (b["alone_m"] is not None and b["alone_m"] >= SITE_ALONE_M)]
    return sorted(keep)


def assign(numbers, spots, homes, direction) -> dict:
    """{number: source_id}. numbers sorted ascending; spots {number: along_m}; homes [(along_m, sid)];
    direction +1: numbers grow with along_m, -1: the other way. Extra numbers (more numbers than homes):
    the ones whose spot is furthest from every home stay out."""
    if not homes or not numbers:
        return {}
    homes = sorted(homes, key=lambda h: direction * h[0])
    numbers = list(numbers)
    while len(numbers) > len(homes):
        far = max(numbers, key=lambda n: min(abs(spots.get(n, 0.0) - q) for q, _ in homes))
        numbers.remove(far)
    if len(numbers) < len(homes):
        return {}  # fewer numbers than numbered buildings: not this pattern, leave it to road order
    return {n: sid for n, (_q, sid) in zip(numbers, homes)}


def site_picks(dsn, region, town, address_df, picks, spots) -> tuple[dict, list]:
    """(picks with site numbers replaced, [(street, parcel, numbers, homes, assignment)] found)."""
    if not SITES or not spots:
        return picks, []
    params = {"region": region.id, "town": town, "state_fips": region.state_fips,
              "min_buildings": SITE_MIN_BUILDINGS}
    out, found = dict(picks), []
    by_street = defaultdict(list)
    for aid, street, n in zip(address_df["id"], address_df["street"], address_df["number"]):
        by_street[street].append((int(n), aid))
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        stretches = conn.execute(STRETCHES_SQL, params).fetchall()
        for street, parcel, lo, hi, inside in stretches:
            s = spots.get(street)
            if s is None or inside < SITE_MIN_INSIDE_M or street not in by_street:
                continue
            start, direction, rate, _length, _k = s
            spot = {n: start + direction * n * rate for n, _ in by_street[street]}
            numbers = sorted({n for n, _ in by_street[street]
                              if lo - SITE_SPOT_MARGIN_M <= spot[n] <= hi + SITE_SPOT_MARGIN_M})
            if len(numbers) < 3:
                continue
            rows = conn.execute(BUILDINGS_SQL, {**params, "street": street, "parcel": parcel}).fetchall()
            buildings = [dict(source_id=r[0], along_m=r[1], off_m=r[2], m2=r[3], alone_m=r[4]) for r in rows]
            homes = numbered_buildings(buildings)
            chosen = assign(numbers, spot, homes, direction)
            found.append((street, parcel, numbers, homes, chosen))
            for n, aid in by_street[street]:
                if n in numbers:
                    if n in chosen:
                        out[aid] = chosen[n]
                    else:
                        out.pop(aid, None)  # the site's extra number (its gate): unplaced
    return out, found
