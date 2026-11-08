"""Suggest a street number for houses E911 never numbered.

44 Flying Point Road (Freeport) is a house with its own roof in the 2020
lidar, behind 42 on the same tax lot, and Maine's E911 has no point for it
(38, 39, 41, 42, 43, 45, 47, 48 only). This step finds such houses and
suggests a number from their neighbors on the same side of the street:

1. Unnumbered houses (no E911 point labels them -- the nearest building
   within 30 m of each point, as in dataset.py), residential and
   house-sized (lidar roof, else outline, >= HOUSE_MIN_M2), in two tiers:
   "unnumbered lot" -- no E911 point anywhere on its tax lot; "second
   house" -- on a lot of at most LOT_MAX_BUILDINGS buildings whose numbers
   are taken, at least SECOND_MIN_M2 and SECOND_MIN_SHARE of the lot's
   numbered house, and at least SECOND_MIN_H tall (not a shed or garage).
2. Its street: the road its visible driveway reaches (driveways.py), else
   the nearest street within STREET_MAX_M; its side and distance along it.
3. Its number (suggest_number): numbers on one side of a street share a
   parity and run in order along the road, so the number is a free one of
   that side's parity between the numbers just before and after it,
   nearest to where it falls between them.

Only TIGER streets and the public E911 points (geocoding DB) are used --
never the restricted E911 road file. A suggestion is a suggestion: the
Training data map shows it in its own color, never as E911.

    python -m address_inference.suggest me --town Freeport "dbname=geocoding" [--save]

Prints a leave-one-out check -- every singly numbered E911 house, its own
number removed, suggested again from its neighbors -- then the
suggestions. --save writes address_inference.suggested_numbers.
"""

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass

import psycopg

from .regions import load_region
from .street_names import canonical

TRUE_BUILDING_RADIUS_M = 30   # dataset.TRUE_BUILDING_RADIUS_M
STREET_MAX_M = 200
HOUSE_MIN_M2 = 60
HOUSE_TYPES = ("Single Family Dwelling", "Manufactured Home", "Multi - Family Dwelling")
LOT_MAX_BUILDINGS = 3
SECOND_MIN_M2 = 80
SECOND_MIN_SHARE = 0.5
SECOND_MIN_H = 3.0
DRIVEWAY_MAX_OFF_M = 10       # a visible driveway (order.LANE_MAX_OFF_M)
# Where a house sits along its street: its own projection ("house"), or
# where its visible driveway meets the street ("driveway"). Chosen by the
# leave-one-out check (see main's output).
POSITION = "house"

LINES_CTE = """
WITH lines AS (
    SELECT sms.label_street AS street, ST_LineMerge(ST_Union(s.geom)) AS g
    FROM address_inference.street_match_segments sms
    JOIN streets s ON s.tlid = sms.tlid
    WHERE sms.region_id = %(region)s AND sms.town = %(town)s
    GROUP BY sms.label_street
), line AS (
    -- A street that forks or has gaps merges into several pieces; each piece
    -- is numbered along on its own ("STREET#2").
    SELECT CASE WHEN d.path[1] IS NULL OR d.path[1] = 1 THEN l.street ELSE l.street || '#' || d.path[1] END AS part,
           l.street, d.geom AS g, ST_Length(d.geom::geography) AS len
    FROM lines l, ST_Dump(l.g) d
    WHERE ST_GeometryType(d.geom) = 'ST_LineString'
)
"""

# Meters along the street, and which side (+1 left, -1 right of the
# line's digitized direction): the cross product of the line's direction
# around the closest point with the offset to the point.
ALONG_SIDE = """
    ST_LineLocatePoint(l.g, {p}) * l.len AS along,
    sign((ST_X(ST_LineInterpolatePoint(l.g, least(ST_LineLocatePoint(l.g, {p}) + 0.0005, 1)))
          - ST_X(ST_LineInterpolatePoint(l.g, greatest(ST_LineLocatePoint(l.g, {p}) - 0.0005, 0))))
         * (ST_Y({p}) - ST_Y(ST_ClosestPoint(l.g, {p})))
       - (ST_Y(ST_LineInterpolatePoint(l.g, least(ST_LineLocatePoint(l.g, {p}) + 0.0005, 1)))
          - ST_Y(ST_LineInterpolatePoint(l.g, greatest(ST_LineLocatePoint(l.g, {p}) - 0.0005, 0))))
         * (ST_X({p}) - ST_X(ST_ClosestPoint(l.g, {p})))) AS side
"""

POINTS_SQL = LINES_CTE + f"""
SELECT a.site_uid, a.address_number, l.part, {ALONG_SIDE.format(p="a.geom")}, tb.source_id
FROM address_points a
JOIN LATERAL (
    SELECT * FROM line l WHERE l.street = upper(a.street_fullname)
    ORDER BY ST_Distance(l.g::geography, a.geom::geography) LIMIT 1
) l ON true
LEFT JOIN LATERAL (
    SELECT s.source_id FROM address_inference.structures s
    WHERE s.state_fips = %(state_fips)s AND s.geom && ST_Expand(a.geom, 0.0005)
      AND ST_DWithin(s.geom::geography, a.geom::geography, {TRUE_BUILDING_RADIUS_M})
    ORDER BY ST_Distance(s.geom::geography, a.geom::geography), s.source_id
    LIMIT 1
) tb ON true
WHERE a.town = %(town)s AND a.state_abbr = %(state)s AND a.address_number > 0
ORDER BY a.site_uid
"""

# Every E911 point in town, matched street or not: any of them numbers a
# building or a lot.
ALL_POINTS_SQL = f"""
SELECT a.site_uid, tb.source_id, (SELECT p.parcel_id FROM address_inference.parcels p
                                  WHERE p.state_fips = %(state_fips)s AND p.geom && a.geom
                                    AND ST_Contains(p.geom, a.geom) LIMIT 1)
FROM address_points a
LEFT JOIN LATERAL (
    SELECT s.source_id FROM address_inference.structures s
    WHERE s.state_fips = %(state_fips)s AND s.geom && ST_Expand(a.geom, 0.0005)
      AND ST_DWithin(s.geom::geography, a.geom::geography, {TRUE_BUILDING_RADIUS_M})
    ORDER BY ST_Distance(s.geom::geography, a.geom::geography), s.source_id
    LIMIT 1
) tb ON true
WHERE a.town = %(town)s AND a.state_abbr = %(state)s AND a.address_number > 0
"""

BUILDINGS_SQL = """
SELECT s.source_id, s.occ_cls, s.prim_occ, coalesce(l.roof_m2, s.sqmeters), l.roof_h, bp.parcel_id,
       ST_Y(s.inner_point), ST_X(s.inner_point)
FROM address_inference.building_parcels bp
JOIN address_inference.parcels p ON p.parcel_id = bp.parcel_id AND p.state_fips = bp.state_fips
JOIN address_inference.structures s ON s.state_fips = bp.state_fips AND s.source_id = bp.source_id
LEFT JOIN address_inference.building_lidar l ON l.state_fips = s.state_fips AND l.source_id = s.source_id
WHERE bp.state_fips = %(state_fips)s AND p.town = %(town)s
ORDER BY s.source_id
"""

# Each building against every street line within STREET_MAX_M.
BUILDING_STREETS_SQL = LINES_CTE + f"""
SELECT DISTINCT ON (s.source_id, l.street)
       s.source_id, l.part, ST_Distance(l.g::geography, s.inner_point::geography) AS dist,
       {ALONG_SIDE.format(p="s.inner_point")}
FROM address_inference.building_parcels bp
JOIN address_inference.parcels p ON p.parcel_id = bp.parcel_id AND p.state_fips = bp.state_fips
JOIN address_inference.structures s ON s.state_fips = bp.state_fips AND s.source_id = bp.source_id
JOIN line l ON l.g && ST_Expand(s.inner_point, 0.003)
 AND ST_DWithin(l.g::geography, s.inner_point::geography, {STREET_MAX_M})
WHERE bp.state_fips = %(state_fips)s AND p.town = %(town)s
ORDER BY s.source_id, l.street, dist
"""

# Each building's cheapest driveway (driveways.py), if visible, and where it
# meets each street line within 30 m of its entry.
DRIVEWAYS_SQL = LINES_CTE + f"""
, best AS (
    SELECT DISTINCT ON (source_id) source_id, road, off_m,
           ST_SetSRID(ST_MakePoint(entry_lon, entry_lat), 4326) AS pt
    FROM address_inference.building_driveways
    WHERE state_fips = %(state_fips)s AND entry_lat IS NOT NULL
    ORDER BY source_id, cost
)
SELECT b.source_id, b.road, l.part, ST_LineLocatePoint(l.g, b.pt) * l.len
FROM best b JOIN line l ON l.g && ST_Expand(b.pt, 0.0005) AND ST_DWithin(l.g::geography, b.pt::geography, 30)
WHERE b.off_m <= {DRIVEWAY_MAX_OFF_M}
"""

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.suggested_numbers (
    region_id TEXT NOT NULL,
    town TEXT NOT NULL,
    source_id TEXT NOT NULL,
    street TEXT NOT NULL,
    number INTEGER,
    tier TEXT NOT NULL,
    before_number INTEGER,
    after_number INTEGER,
    reason TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    run_date DATE NOT NULL DEFAULT current_date,
    PRIMARY KEY (region_id, town, source_id)
)
"""


@dataclass(frozen=True)
class Suggestion:
    number: int | None
    before: int | None   # the neighbor's number just before it along the road
    after: int | None
    reason: str


def side_parity(points, side):
    """The parity of the numbers on `side` of a street: the majority there,
    else the opposite of the other side's majority. None if no numbers."""
    same = Counter(n % 2 for n, _, s in points if s == side)
    if same:
        return same.most_common(1)[0][0]
    other = Counter(n % 2 for n, _, s in points if s != side)
    return 1 - other.most_common(1)[0][0] if other else None


def expected_number(points, along):
    """Where `along` falls in the street's numbering (Maine numbers by
    distance): interpolated between the nearest numbers before and after it
    on either side, else extrapolated from the two nearest numbers' slope."""
    pts = sorted((a, n) for n, a, _ in points)
    before = [p for p in pts if p[0] <= along]
    after = [p for p in pts if p[0] > along]
    if before and after:
        (a1, n1), (a2, n2) = before[-1], after[0]
        return n1 + (n2 - n1) * ((along - a1) / (a2 - a1) if a2 > a1 else 0.5)
    end = before[-2:] if before else after[:2]
    if len(end) < 2 or end[1][0] == end[0][0]:
        return float(end[0][1])
    (a1, n1), (a2, n2) = end
    return n1 + (n2 - n1) / (a2 - a1) * (along - a1)


def suggest_number(points, along, side) -> Suggestion:
    """points: [(number, along_m, side)] -- one street's E911 numbers.
    The free number of this side's parity nearest to expected_number, kept
    strictly between this side's neighbors just before and after `along`."""
    parity = side_parity(points, side)
    if parity is None:
        return Suggestion(None, None, None, "no numbers on this street")
    used = {n for n, _, _ in points}
    mine = sorted((a, n) for n, a, s in points if s == side and n % 2 == parity)
    before = max((p for p in mine if p[0] <= along), default=None)
    after = min((p for p in mine if p[0] > along), default=None)
    b, a = before and before[1], after and after[1]
    expected = expected_number(points, along)
    if b is not None and a is not None:
        lo, hi = sorted((b, a))
    else:
        # Past this side's last (or first) number: beyond it, the way the
        # street's numbers run there.
        near = b if b is not None else a
        rising = expected >= near if near is not None else True
        if near is None:
            lo, hi = 0, 10 ** 6
        elif rising:
            lo, hi = near, 10 ** 6
        else:
            lo, hi = 0, near
    target = min(max(expected, lo + 1), hi - 1)
    free = [n for n in range(max(lo + 1, int(target) - 400), min(hi, int(target) + 400))
            if n % 2 == parity and n not in used and n > 0]
    if not free:
        return Suggestion(None, b, a, f"no free number between {b} and {a}")
    return Suggestion(min(free, key=lambda n: (abs(n - expected), n)), b, a,
                      "between" if b is not None and a is not None else "past the end")


def load(dsn, region, town):
    params = {"region": region.id, "town": town, "state_fips": region.state_fips, "state": region.state_abbr}
    with psycopg.connect(dsn) as conn:
        points = conn.execute(POINTS_SQL, params).fetchall()
        all_points = conn.execute(ALL_POINTS_SQL, params).fetchall()
        buildings = conn.execute(BUILDINGS_SQL, params).fetchall()
        streets = conn.execute(BUILDING_STREETS_SQL, params).fetchall()
        has_driveways = conn.execute(
            "SELECT to_regclass('address_inference.building_driveways') IS NOT NULL").fetchone()[0]
        driveways = conn.execute(DRIVEWAYS_SQL, params).fetchall() if has_driveways else []
    return points, all_points, buildings, streets, driveways


def unnumbered_houses(all_points, buildings):
    """{source_id: tier} for houses no E911 point numbers."""
    numbered = {b for _, b, _ in all_points if b}
    lots_with_points = {p for _, _, p in all_points if p}
    by_lot = defaultdict(list)
    for sid, _, _, roof, _, lot, _, _ in buildings:
        by_lot[lot].append((sid, roof or 0))
    out = {}
    for sid, occ, prim, roof, height, lot, _, _ in buildings:
        if sid in numbered or occ != "Residential" or prim not in HOUSE_TYPES or (roof or 0) < HOUSE_MIN_M2:
            continue
        lot_numbered = [r for b, r in by_lot[lot] if b in numbered]
        if not lot_numbered and lot not in lots_with_points:
            out[sid] = "unnumbered lot"
        elif (lot_numbered and len(by_lot[lot]) <= LOT_MAX_BUILDINGS and roof >= SECOND_MIN_M2
              and roof >= SECOND_MIN_SHARE * max(lot_numbered) and (height or 0) >= SECOND_MIN_H):
            out[sid] = "second house"
    return out


def placements(streets, driveways, position=None):
    """{source_id: (street, along, side)}: the street its visible driveway
    reaches, else the nearest; along from `position` (see POSITION)."""
    position = position or POSITION
    near = defaultdict(dict)
    for sid, street, dist, along, side in streets:
        near[sid][street] = (dist, along, side)
    entry = {(sid, street): (road, along) for sid, road, street, along in driveways}
    out = {}
    for sid, options in near.items():
        drive = [st for st in options if (sid, st) in entry and canonical(st.split('#')[0]) == entry[(sid, st)][0]]
        street = drive[0] if drive else min(options, key=lambda st: (options[st][0], st))
        _, along, side = options[street]
        if position == "driveway" and (sid, street) in entry:
            along = entry[(sid, street)][1]
        out[sid] = (street, along, side)
    return out


def street_numbers(points):
    """{street: [(number, along, side)]}, each number once (its first point)."""
    out, seen = defaultdict(list), set()
    for _, n, street, along, side, _ in points:
        if (street, n) not in seen and side:
            seen.add((street, n))
            out[street].append((n, along, side))
    return out


def leave_one_out(points, streets, driveways, position=None):
    """(right, tried): every house exactly one E911 number labels, on that
    number's own street, suggested again with its number taken out."""
    numbers = street_numbers(points)
    per_building = Counter(b for *_, b in points if b)
    near = defaultdict(dict)
    for sid, street, dist, along, side in streets:
        near[sid][street] = (dist, along, side)
    entry = {(sid, street): along for sid, _, street, along in driveways}
    right = tried = 0
    for _, n, street, _, _, b in points:
        if not b or per_building[b] != 1 or street not in near.get(b, {}):
            continue
        _, along, side = near[b][street]
        if (position or POSITION) == "driveway" and (b, street) in entry:
            along = entry[(b, street)]
        others = [p for p in numbers[street] if p[0] != n]
        tried += 1
        right += suggest_number(others, along, side).number == n
    return right, tried


def suggest(points, all_points, buildings, streets, driveways):
    """[(source_id, street, tier, Suggestion, lat, lon)]."""
    numbers = street_numbers(points)
    where = placements(streets, driveways)
    latlon = {sid: (lat, lon) for sid, *_, lat, lon in buildings}
    out = []
    for sid, tier in sorted(unnumbered_houses(all_points, buildings).items()):
        if sid not in where:
            continue
        street, along, side = where[sid]
        out.append((sid, street.split('#')[0], tier, suggest_number(numbers.get(street, []), along, side), *latlon[sid]))
    return out


def save(dsn, region, town, rows):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_SQL)
        conn.execute("DELETE FROM address_inference.suggested_numbers WHERE region_id = %s AND town = %s",
                     (region.id, town))
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO address_inference.suggested_numbers "
                "(region_id, town, source_id, street, number, tier, before_number, after_number, reason, lat, lon) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [(region.id, town, sid, street, s.number, tier, s.before, s.after, s.reason, lat, lon)
                 for sid, street, tier, s, lat, lon in rows])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("--save", action="store_true")
    parser.add_argument("dsn")
    args = parser.parse_args()
    region = load_region(args.region)
    loaded = load(args.dsn, region, args.town)
    points, _, _, streets, driveways = loaded
    for position in ("house", "driveway"):
        right, tried = leave_one_out(points, streets, driveways, position)
        print(f"leave-one-out, position={position}: {right}/{tried} = {right / max(tried, 1):.1%} exact number")
    rows = suggest(*loaded)
    by = Counter((tier, s.number is not None) for _, _, tier, s, _, _ in rows)
    for (tier, has), n in sorted(by.items()):
        print(f"{tier}: {n} {'with a number' if has else 'without (no free number / no neighbors)'}")
    for sid, street, tier, s, _, _ in rows:
        if "FLYING POINT" in street and s.number and s.number < 60:
            print(f"  {s.number} {street} ({tier}, between {s.before} and {s.after}) {sid[:8]}")
    if args.save:
        save(args.dsn, region, args.town, rows)
        print(f"saved {len(rows)} rows to address_inference.suggested_numbers")


if __name__ == "__main__":
    main()
