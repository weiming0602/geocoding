"""Stage 3 data: one row per (address, candidate building), with features,
the E911 label, and the geometry baselines (M0-M2) computed alongside.

For each E911 address on a street Stage 1b matched to TIGER:

  covering range   the street segment + side whose TIGER range holds the
                   house number (same parity), and the number's fraction f
                   along it. No covering range = the address isn't scorable
                   by any TIGER-based method (counted, not dropped silently).
  M0               today's interpolation: f along that segment, offset 20 ft
                   to that side (geocoding/interpolate.py's own function).
  candidates       buildings Stage 2 attached to any of the street's
                   segments, nearest MAX_CANDIDATES to M0.
  true building    the footprint containing the E911 point, else the nearest
                   one within TRUE_BUILDING_RADIUS_M, else none.

Only TIGER + footprints feed the features; E911 supplies the label and
nothing else.
"""

from collections import defaultdict

import numpy as np
import pandas as pd
import psycopg

from .street_lines import street_lines

from geocoding.interpolate import interpolate_along_line, parse_linestring

from .street_names import canonical

MAX_CANDIDATES = 50
TRUE_BUILDING_RADIUS_M = 30
OFFSET_FEET = 20  # same as geocoding-server's default OFFSET_FEET
# Buildings this close to a bigger building nearer the road are likely its
# garage/barn: the "bigger building in front" feature.
OUTBUILDING_RADIUS_M = 40

ADDRESSES_SQL = """
SELECT a.site_uid, a.address_number, sm.label_street, sm.method,
       ST_Y(a.geom), ST_X(a.geom), tb.source_id
FROM address_points a
JOIN address_inference.street_matches sm
  ON sm.region_id = %(region)s AND sm.town = a.town AND sm.label_street = upper(a.street_fullname)
 AND sm.status = 'matched'
LEFT JOIN LATERAL (
    SELECT s.source_id FROM address_inference.structures s
    WHERE s.state_fips = %(state_fips)s
      AND s.geom && ST_Expand(a.geom, 0.0005)
      AND ST_DWithin(s.geom::geography, a.geom::geography, %(radius)s)
    ORDER BY ST_Distance(s.geom::geography, a.geom::geography), s.source_id
    LIMIT 1
) tb ON true
WHERE a.town = %(town)s AND a.state_abbr = %(state)s AND a.address_number > 0
ORDER BY a.site_uid
"""

SEGMENTS_SQL = """
SELECT sms.label_street, st.tlid, st.lfromadd, st.ltoadd, st.rfromadd, st.rtoadd, st.geometry,
       ST_Length(st.geom::geography),
       -- Dead ends: a segment end no other road touches (within 2 m).
       NOT EXISTS (SELECT 1 FROM streets o WHERE o.tlid <> st.tlid
                     AND o.geom && ST_Expand(ST_StartPoint(st.geom), 0.0001)
                     AND ST_DWithin(o.geom::geography, ST_StartPoint(st.geom)::geography, 2)) AS dead_start,
       NOT EXISTS (SELECT 1 FROM streets o WHERE o.tlid <> st.tlid
                     AND o.geom && ST_Expand(ST_EndPoint(st.geom), 0.0001)
                     AND ST_DWithin(o.geom::geography, ST_EndPoint(st.geom)::geography, 2)) AS dead_end,
       st.fullname
FROM address_inference.street_match_segments sms
JOIN address_inference.streets_ext st ON st.tlid = sms.tlid
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
ORDER BY sms.label_street, st.tlid
"""

# Every building attached to a matched street's segments, with its own
# nearest road (any street) for the "is this street even its nearest?" features.
CANDIDATES_SQL = """
SELECT sms.label_street, bs.source_id, bs.tlid, bs.side, bs.t, bs.at_end, bs.dist_m,
       {size} AS sqmeters, s.occ_cls, s.prim_occ, s.outbldg, ST_Y(s.inner_point), ST_X(s.inner_point),
       nearest.tlid AS nearest_tlid, nearest.dist_m AS nearest_dist_m,
       bs.rank = 99 AS via_lane  -- attach.LANE_RANK: a lane house, placed where its lane meets the road
FROM address_inference.street_match_segments sms
JOIN address_inference.building_segments bs ON bs.tlid = sms.tlid AND bs.state_fips = %(state_fips)s
JOIN address_inference.structures s
  ON s.state_fips = bs.state_fips AND s.source = bs.source AND s.source_id = bs.source_id
{lidar_join}
-- The building's nearest road among those its tax lot touches (owner's
-- rule): a road only serves the lots along it, so a closer road the lot
-- doesn't touch doesn't pull the building off the road its lot runs out to
-- (48 Flying Point Road's house is 94 m nearer private Johns Road, which
-- its lot never touches). Without a lot, or a lot touching no attached
-- road, it's simply the nearest road.
JOIN LATERAL (
    SELECT n.tlid, n.dist_m FROM address_inference.building_segments n
    WHERE n.state_fips = bs.state_fips AND n.source = bs.source AND n.source_id = bs.source_id
    ORDER BY NOT EXISTS (
                 SELECT 1 FROM address_inference.building_parcels bp
                 JOIN address_inference.parcel_frontage pf ON pf.parcel_id = bp.parcel_id
                 WHERE bp.state_fips = n.state_fips AND bp.source_id = n.source_id AND pf.tlid = n.tlid),
             n.dist_m, n.tlid
    LIMIT 1
) nearest ON true
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
ORDER BY sms.label_street, bs.source_id, bs.tlid, nearest.tlid
"""


# A building past the end of its street (every attachment to the street at
# a segment end) within this angle of the road's continuing direction is
# "beyond the end": its left/right side is a coin flip decided by the last
# few meters of the line, so it counts for either side. Dead ends are
# where E911 and TIGER lines often stop short of the last house
# (Arrowhead Ridge Road's 9 is ~100 m past E911's line).
BEYOND_END_MAX_ANGLE_DEG = 45


# How a house past a dead end gets its side:
#   "either"    -- it counts for both sides (the ordering and scores decide);
#   "axis"      -- its side of the straight line from the segment's start
#                  to its end (the street's overall direction, not the
#                  last few meters of the line);
#   "neighbors" -- the side of its two nearest same-street houses that
#                  aren't past the end.
DEAD_END_SIDE = "axis"


def side_of_chord(points, lat, lon) -> str:
    """'L' or 'R' of the straight line from the first to the last point."""
    (ax, ay), (bx, by) = points[0], points[-1]
    k = np.cos(np.radians(ay))
    cross = (bx - ax) * k * (lat - ay) - (by - ay) * (lon - ax) * k
    return "L" if cross > 0 else "R"


def beyond_end(points, t, lat, lon) -> bool:
    """Is (lat, lon) ahead of the segment's end at t (0 or 1), inside
    BEYOND_END_MAX_ANGLE_DEG of the line's direction there?"""
    if t not in (0, 1) or len(points) < 2:
        return False
    (ax, ay), (bx, by) = (points[-2], points[-1]) if t == 1 else (points[1], points[0])
    kx = np.cos(np.radians(by))  # degrees of longitude are shorter by cos(lat)
    dx, dy = (bx - ax) * kx, by - ay
    vx, vy = (lon - bx) * kx, lat - by
    norm = np.hypot(dx, dy)
    if norm == 0:
        return False
    forward = (vx * dx + vy * dy) / norm
    lateral = abs(vx * dy - vy * dx) / norm
    return forward > 0 and lateral <= forward * np.tan(np.radians(BEYOND_END_MAX_ANGLE_DEG))


def haversine_m(lat1, lon1, lat2, lon2):
    """Meters; works on scalars or numpy arrays."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6_371_000 * np.arcsin(np.sqrt(a))


def _int_or_none(value):
    return int(value) if value and str(value).isdigit() else None


# Owner's rule: a TIGER piece with a range on one side only gets the other
# side's range mirrored onto its empty side, in the other parity (even 26->2
# -> odd 25->1). Basin Point Road: TIGER has no odd range on its first 430 m
# (even 2-26 there) and puts odd 1-299 on the next 600 m, so 11-35 were looked
# for ~400 m past their houses. The tightest covering range wins
# (covering_range), so the borrowed one takes over where both cover.
FILL_MISSING_SIDE = True


def _other_parity(x: int) -> int:
    return x - 1 if x - 1 >= 1 else x + 1


def fill_missing_sides(segs) -> None:
    """In place: mirror a one-sided piece's range onto its empty side."""
    for seg in segs:
        lf, lt = _int_or_none(seg["lfromadd"]), _int_or_none(seg["ltoadd"])
        rf, rt = _int_or_none(seg["rfromadd"]), _int_or_none(seg["rtoadd"])
        if lf is not None and lt is not None and (rf is None or rt is None):
            seg["rfromadd"], seg["rtoadd"] = str(_other_parity(lf)), str(_other_parity(lt))
            seg["filled_side"] = "R"
        elif rf is not None and rt is not None and (lf is None or lt is None):
            seg["lfromadd"], seg["ltoadd"] = str(_other_parity(rf)), str(_other_parity(rt))
            seg["filled_side"] = "L"


# Owner's rule: a street whose TIGER pieces include ones with NO range on
# either side (branches, lanes TIGER never numbered) is numbered from its own
# address list instead, spread in order along the whole street line (Ash Cove
# South's south branch had no range at all; Ash Cove Road's north branch none,
# so 64/75 fell on the main stretch). Applies when unranged pieces make up at
# least RELIST_MIN_SHARE of the street's length (1.0 = only streets with no
# range at all). Direction and odd/even side come from TIGER's ranged pieces
# where there are any; with none, low numbers start at the end that joins
# another road and either side is allowed (no parity -> side guess).
RELIST_MIN_SHARE = 1.0  # only streets with no TIGER range at all (Harpswell, short links + split: 2,218 vs 2,220 best, Ash Cove South 2-12 all right). Earlier, without short links: 2026-11-13 Harpswell (split on): off 2,215 | 1.0 2,215 | 0.5 2,211 | 0.25 2,157 | 0.15 1,982 right -- off; unranged pieces get no building attachments (attach.py), so relisting them finds no houses


def _unranged(seg) -> bool:
    return all(_int_or_none(seg[k]) is None for k in ("lfromadd", "ltoadd", "rfromadd", "rtoadd"))


def relist_streets(segs_by_street, side_numbers, min_share=None) -> list:
    """In place: list-based ranges on streets with unranged pieces. Returns the streets changed."""
    from shapely.geometry import LineString, MultiLineString, Point as SPoint
    from shapely.ops import linemerge, unary_union
    from .street_lines import single_line
    share_min = RELIST_MIN_SHARE if min_share is None else min_share
    changed = []
    for street, segs in segs_by_street.items():
        lines = [LineString(s["points"]) for s in segs if len(s["points"]) >= 2]
        if not lines:
            continue
        total = sum(l.length for l in lines)
        bare = sum(LineString(s["points"]).length for s in segs if _unranged(s) and len(s["points"]) >= 2)
        if total == 0 or bare / total < share_min:
            continue
        u = unary_union(lines)
        merged = u if isinstance(u, LineString) else linemerge(u)
        line = single_line(merged)
        if line is None or line.length == 0:
            continue
        L = line.length
        pos = lambda p: line.project(SPoint(p))
        # TIGER's own say, from ranged pieces: per parity, which way numbers grow
        # along `line`, and which side of `line` holds them.
        grow, side_vote = defaultdict(float), defaultdict(float)
        for s in segs:
            if _unranged(s) or len(s["points"]) < 2:
                continue
            a0, a1 = pos(s["points"][0]), pos(s["points"][-1])
            if a0 == a1:
                continue
            same_dir = a1 > a0
            w = LineString(s["points"]).length
            for side, fk, tk in (("L", "lfromadd", "ltoadd"), ("R", "rfromadd", "rtoadd")):
                fr, to = _int_or_none(s[fk]), _int_or_none(s[tk])
                if fr is None or to is None or fr == to:
                    continue
                parity = fr % 2
                grow[parity] += (1 if same_dir else -1) * (1 if to > fr else -1) * w
                line_side = side if same_dir else ("R" if side == "L" else "L")
                side_vote[parity] += (1 if line_side == "L" else -1) * w
        # Fallback direction: low numbers at the end joining another road.
        start_pt, end_pt = line.coords[0], line.coords[-1]
        def dead_at(pt):
            for s in segs:
                if len(s["points"]) < 2:
                    continue
                if SPoint(s["points"][0]).distance(SPoint(pt)) < 1e-6:
                    return bool(s.get("dead_start", True))
                if SPoint(s["points"][-1]).distance(SPoint(pt)) < 1e-6:
                    return bool(s.get("dead_end", True))
            return True
        default_dir = -1 if (dead_at(start_pt) and not dead_at(end_pt)) else 1
        new = {}
        for parity in (0, 1):
            nums = side_numbers.get((street, parity))
            if not nums:
                continue
            lo, hi = nums[0], nums[-1]
            d = (1 if grow[parity] > 0 else -1) if grow[parity] else default_dir
            side = ("L" if side_vote[parity] > 0 else "R") if side_vote[parity] else None
            new[parity] = (lo, hi, d, side)
        if not new:
            continue
        for s in segs:
            if len(s["points"]) < 2:
                continue
            p0, p1 = pos(s["points"][0]), pos(s["points"][-1])
            for k in ("lfromadd", "ltoadd", "rfromadd", "rtoadd"):
                s[k] = None
            both = False
            for parity, (lo, hi, d, side) in new.items():
                def num_at(p):
                    f = p / L if d > 0 else 1 - p / L
                    n = int(round(lo + f * (hi - lo)))
                    return n if n % 2 == parity else (n + 1 if n < hi else n - 1)
                fr, to = num_at(p0), num_at(p1)
                if side is None:
                    both = True
                    side = "L" if parity == 0 else "R"  # placeholder slot; either side counts (both_sides)
                # side is relative to `line`; flip to the piece's own L/R when it runs the other way
                piece_side = side if p1 >= p0 else ("R" if side == "L" else "L")
                fk, tk = ("lfromadd", "ltoadd") if piece_side == "L" else ("rfromadd", "rtoadd")
                if s[fk] is not None:  # both parities on one side: keep the other side's slot
                    fk, tk = ("rfromadd", "rtoadd") if fk == "lfromadd" else ("lfromadd", "ltoadd")
                    both = True
                s[fk], s[tk] = str(fr), str(to)
            s["both_sides"] = both
            s["relisted"] = True
        changed.append(street)
    return changed


# A range borrowed by FILL_MISSING_SIDE beats a real TIGER range of the same parity only when the real one is at
# least this many times looser (Basin Point Road: real odd 1-299 over 600 m vs borrowed 25-1 -> borrowed wins;
# Washington Avenue: real odd 25-1 where 13-21 are vs a 50 m piece's borrowed 23-1 -> the real one must win, the
# borrowed one put 13-21's spots on 3's house). None = tightest always wins.
BORROWED_WIN_FACTOR = None


def covering_range(number: int, segments):
    """(segment, side 'L'/'R', fraction f, range size) whose range holds
    `number` with the range's own parity -- or None. When several ranges
    cover it (overlapping TIGER ranges), the tightest one wins."""
    best = best_real = None
    for seg in segments:
        for side, lo_key, hi_key in (("L", "lfromadd", "ltoadd"), ("R", "rfromadd", "rtoadd")):
            start, end = _int_or_none(seg[lo_key]), _int_or_none(seg[hi_key])
            if start is None or end is None:
                continue
            if not min(start, end) <= number <= max(start, end):
                continue
            if start % 2 == end % 2 and number % 2 != start % 2:
                continue  # wrong parity for this side's range
            fraction = 0.5 if start == end else (number - start) / (end - start)
            span = abs(end - start)
            # Tightest range wins; equal spans go to the lowest tlid, so the
            # answer never depends on the order segments arrive in.
            if best is None or (span, str(seg["tlid"])) < (best[3], str(best[0]["tlid"])):
                best = (seg, side, fraction, span)
            if seg.get("filled_side") != side and (
                    best_real is None or (span, str(seg["tlid"])) < (best_real[3], str(best_real[0]["tlid"]))):
                best_real = (seg, side, fraction, span)
    if (BORROWED_WIN_FACTOR is not None and best is not None and best_real is not None and best is not best_real
            and best[0].get("filled_side") == best[1] and best_real[3] < BORROWED_WIN_FACTOR * max(best[3], 1)):
        return best_real
    return best


# Each candidate building's tax parcel (address_inference.parcels): the
# lot's frontage on each street segment, how many buildings share the lot,
# and which is the biggest. Empty when parcels aren't loaded.
# Owner's rule (2026-11-16): a shed stands close to its house, so a building
# far from every other building is never a shed, whatever its size. With
# SHED_NEAR_M set, parcel_size_ratio compares a building only with the
# buildings of its lot within SHED_NEAR_M (itself included): none that close ->
# 1.0. Bowdoin's campus lot (Bayview Road): 250's 124 m2 house was 0.19 of the
# 658 m2 lab across the site and the ranker scored it -0.91 for that alone;
# 252's building, 144 m from any other, was 0.23. None = the whole lot's biggest.
SHED_NEAR_M = None
# "near": compare only with same-lot buildings within SHED_NEAR_M (none -> 1.0).
# "alone": owner's literal rule -- only a building with no other building at all
# within SHED_NEAR_M has its size ignored (1.0); every other building keeps the
# whole-lot comparison. 2026-11-16, 7 towns right numbers (14,237 off): near 40 m
# 14,115 (Yarmouth -133, Harpswell -32, Freeport +20, Topsham +23).
SHED_MODE = "near"
PARCELS_SQL = """
SELECT bp.source_id, bp.parcel_id, ST_Area(p.geom::geography),
       count(*) OVER (PARTITION BY bp.parcel_id),
       {size} = max({size}) OVER (PARTITION BY bp.parcel_id),
       {ratio}
FROM address_inference.building_parcels bp
JOIN address_inference.parcels p ON p.parcel_id = bp.parcel_id AND p.state_fips = bp.state_fips
JOIN address_inference.structures s ON s.state_fips = bp.state_fips AND s.source_id = bp.source_id
{lidar_join}
WHERE bp.state_fips = %(state_fips)s AND p.town = %(town)s
ORDER BY bp.source_id
"""
FRONTAGE_SQL = """
SELECT pf.parcel_id, pf.tlid, pf.frontage_m
FROM address_inference.parcel_frontage pf
JOIN address_inference.parcels p ON p.parcel_id = pf.parcel_id
WHERE p.town = %(town)s AND p.state_fips = %(state_fips)s
ORDER BY pf.parcel_id, pf.tlid
"""


# Optional per-building details: address_inference.building_pool (a pool
# near the building -- a home, not a barn; owner's rule) when loaded.
POOLS_SQL = "SELECT source_id, d FROM address_inference.building_pool"


# Which road each set-back building's driveway reaches (driveways.py): the
# cheapest path over pavement from the building to each nearby named road.
DRIVEWAYS_SQL = "SELECT source_id, road, cost, off_m FROM address_inference.building_driveways"


# Owner's idea (2026-11-14): a house reached by a foot path/trail, like a
# driveway (252 Bayview Road: no driveway in the imagery, 179 m from the
# campus drive, but an OSM trail walks 242 m to Bayview and 1,037 m+ to any
# other road). building_trails (data/session_2026-11-14_trails/trails.py):
# walk length over OSM paths + drives to each street. Used only for buildings
# with no imagery driveway and at least TRAIL_MIN_PATH_M walked on paths
# (a house beside a drive isn't a trail house); the walk counts as a fully
# visible driveway (off pavement 0). Never changes a building's position.
TRAILS = False  # 2026-11-14 Harpswell: 3,285 -> 3,284 (170 Bayview broke, 252 unchanged); campus-core buildings on trails also got the lane signal
TRAIL_MIN_PATH_M = 40
TRAILS_SQL = """SELECT t.source_id, t.road, t.walk_m FROM address_inference.building_trails t
WHERE t.source_id IN (SELECT source_id FROM address_inference.building_trails WHERE path_m >= %s)"""


def load_driveways(conn) -> tuple[dict, dict]:
    """({source_id: {road: path cost}}, {source_id: {road: meters off pavement}})."""
    if conn.execute("SELECT to_regclass('address_inference.building_driveways') IS NULL").fetchone()[0]:
        return {}, {}
    costs, offs = defaultdict(dict), defaultdict(dict)
    for sid, road, cost, off_m in conn.execute(DRIVEWAYS_SQL).fetchall():
        costs[sid][road] = cost
        if off_m is not None:
            offs[sid][road] = off_m
    if TRAILS and not conn.execute("SELECT to_regclass('address_inference.building_trails') IS NULL").fetchone()[0]:
        trails = defaultdict(dict)
        for sid, road, walk_m in conn.execute(TRAILS_SQL, (TRAIL_MIN_PATH_M,)).fetchall():
            if sid not in costs:
                trails[sid][road] = walk_m
        for sid, roads in trails.items():
            costs[sid] = roads
            offs[sid] = {road: 0.0 for road in roads}
    return dict(costs), dict(offs)


# Trees over and around each building (canopy.py): a tree-covered outline
# was traced short, so its size is unreliable.
CANOPY_SQL = "SELECT source_id, canopy_over, canopy_ring, width_m FROM address_inference.building_canopy"


def load_canopy(conn) -> dict:
    if conn.execute("SELECT to_regclass('address_inference.building_canopy') IS NULL").fetchone()[0]:
        return {}
    return {sid: (over, ring, width) for sid, over, ring, width in conn.execute(CANOPY_SQL).fetchall()}


# A building's size: its footprint outline, or the roof the lidar sees
# (lidar.py) when that is bigger -- an outline traced from aerial photos
# stops where trees hide the roof (42 Flying Point Road: 78 m2 outline,
# 181 m2 roof). Used everywhere size counts: the ranker's inputs, a lot's
# biggest building, sheds. Off: Freeport TIGER 53.8 -> 52.3%, E911 roads
# 66.5 -> 64.7% -- a new size reshuffles the whole ranker.
LIDAR_SIZE = False


def size_ratio_sql(size: str, lidar: bool) -> str:
    """parcel_size_ratio: against the whole lot's biggest, or (SHED_NEAR_M) only the lot's
    buildings within SHED_NEAR_M of this one."""
    lot_ratio = f"{size} / nullif(max({size}) OVER (PARTITION BY bp.parcel_id), 0)"
    if SHED_NEAR_M is None:
        return lot_ratio
    if SHED_MODE == "alone":
        return f"""CASE WHEN EXISTS (SELECT 1 FROM address_inference.structures o
                         WHERE o.state_fips = s.state_fips AND o.source_id != s.source_id
                           AND o.geom && ST_Expand(s.geom, 0.002)
                           AND ST_DWithin(o.geom::geography, s.geom::geography, {float(SHED_NEAR_M)}))
                       THEN {lot_ratio} ELSE 1.0 END"""
    osize = "greatest(o.sqmeters, ol.roof_m2)" if lidar else "o.sqmeters"
    ojoin = ("LEFT JOIN address_inference.building_lidar ol ON ol.state_fips = o.state_fips "
             "AND ol.source_id = o.source_id") if lidar else ""
    return f"""{size} / nullif(greatest({size}, (
        SELECT max({osize}) FROM address_inference.building_parcels ob
        JOIN address_inference.structures o ON o.state_fips = ob.state_fips AND o.source_id = ob.source_id
        {ojoin}
        WHERE ob.state_fips = bp.state_fips AND ob.parcel_id = bp.parcel_id AND ob.source_id != bp.source_id
          AND o.geom && ST_Expand(s.geom, 0.001)
          AND ST_DWithin(o.geom::geography, s.geom::geography, {float(SHED_NEAR_M)}))), 0)"""


def sized(sql: str, conn) -> str:
    """`sql` with {size} / {lidar_join} / {ratio} filled in for this database."""
    use = LIDAR_SIZE and not conn.execute(
        "SELECT to_regclass('address_inference.building_lidar') IS NULL").fetchone()[0]
    if not use:
        return sql.format(size="s.sqmeters", lidar_join="", ratio=size_ratio_sql("s.sqmeters", False))
    size = "greatest(s.sqmeters, bl.roof_m2)"
    return sql.format(size=size, ratio=size_ratio_sql(size, True),
                      lidar_join="LEFT JOIN address_inference.building_lidar bl\n"
                                 "  ON bl.state_fips = s.state_fips AND bl.source_id = s.source_id")


def load_pools(conn) -> dict:
    if conn.execute("SELECT to_regclass('address_inference.building_pool') IS NULL").fetchone()[0]:
        return {}
    return {sid: d for sid, d in conn.execute(POOLS_SQL).fetchall()}


# Where each lot meets each Stage 1b street: the middle of the street's
# stretch within 15 m of the lot -- in practice the driveway entrance. A
# house far back at the end of a long driveway (48 Flying Point Road: 226 m)
# is measured from there too (d_m0_access), not only from where it sits.
LOT_ACCESS_SQL = """
WITH lines AS (SELECT street, g FROM street_lines)
SELECT l.street, p.parcel_id, ST_Y(pt), ST_X(pt)
FROM lines l
JOIN address_inference.parcels p
  ON p.state_fips = %(state_fips)s AND p.town = %(town)s AND p.geom && ST_Expand(l.g, 0.0003)
 AND ST_DWithin(p.geom::geography, l.g::geography, 15)
CROSS JOIN LATERAL (SELECT ST_ClosestPoint(l.g, ST_Centroid(ST_Intersection(l.g,
                     ST_Buffer(p.geom::geography, 15)::geometry))) AS pt) x
WHERE ST_GeometryType(l.g) = 'ST_LineString' AND NOT ST_IsEmpty(pt)
ORDER BY l.street, p.parcel_id
"""


def load_parcels(conn, params) -> dict | None:
    if conn.execute("SELECT to_regclass('address_inference.building_parcels') IS NULL").fetchone()[0]:
        return None
    buildings = {sid: {"parcel": pid, "area": area, "buildings": n, "largest": bool(largest),
                       "size_ratio": ratio}
                 for sid, pid, area, n, largest, ratio in conn.execute(sized(PARCELS_SQL, conn), params).fetchall()}
    frontage = defaultdict(dict)
    for pid, tlid, m in conn.execute(FRONTAGE_SQL, params).fetchall():
        frontage[pid][tlid] = m
    street_lines(conn, params)
    access = {(street, pid): (lat, lon) for street, pid, lat, lon in conn.execute(LOT_ACCESS_SQL, params).fetchall()}
    return {"buildings": buildings, "frontage": dict(frontage), "access": access} if buildings else None


def load(dsn, region, town: str):
    params = {"region": region.id, "town": town, "state": region.state_abbr,
              "state_fips": region.state_fips, "radius": TRUE_BUILDING_RADIUS_M}
    with psycopg.connect(dsn) as conn:
        addresses = conn.execute(ADDRESSES_SQL, params).fetchall()
        segments = conn.execute(SEGMENTS_SQL, params).fetchall()
        candidates = conn.execute(sized(CANDIDATES_SQL, conn), params).fetchall()
        parcels = load_parcels(conn, params)
        if parcels is not None:
            parcels["pools"] = load_pools(conn)
            parcels["canopy"] = load_canopy(conn)
            parcels["driveways"], parcels["driveway_off"] = load_driveways(conn)
    return addresses, segments, candidates, parcels


def tiger_span(segments, parity):
    """(lowest, highest) TIGER number on any range that can hold `parity`
    across a street's segments, or None."""
    ends = []
    for seg in segments:
        for lo_key, hi_key in (("lfromadd", "ltoadd"), ("rfromadd", "rtoadd")):
            start, end = _int_or_none(seg[lo_key]), _int_or_none(seg[hi_key])
            if start is None or end is None:
                continue
            if start % 2 == end % 2 and start % 2 != parity:
                continue
            ends += [start, end]
    return (min(ends), max(ends)) if ends else None


# ranges='auto': the list's scale replaces TIGER's only when TIGER's range
# on that street side runs at least this many times past the list's
# highest number -- a placeholder range like Arrowhead Ridge Road's 1-99
# for real numbers 1-9. Where TIGER's ranges track the real numbers
# (Flying Point Road: 55 segments, 153-155, 157-161, ...), they're kept.
AUTO_INFLATION = 2.0
# ...and only when the side's numbers are SEQUENTIAL (subdivision-style
# 1, 3, 5, 7, 9: few gaps), not distance-based (Brickyard Cove's 12, 22,
# 42, 44). Distance-based numbers mark position along the road, so TIGER's
# wide range can be right even when the houses stop early. Density = how
# many of the parity's slots between min and max are taken.
AUTO_MIN_DENSITY = 0.7


def list_range_number(number, side_numbers, segments, min_inflation=None):
    """`number` moved onto TIGER's numbering by its place in the LIST's own
    min..max for its side (parity): the list sets the scale, TIGER only
    says which segment comes first and which side holds the parity. With
    fewer than two distinct numbers on the side there's no scale: the
    number is used as-is (TIGER's range)."""
    lo, hi = side_numbers[0], side_numbers[-1]
    span = tiger_span(segments, number % 2)
    if hi == lo or span is None:
        return number
    t_lo, t_hi = span
    if min_inflation is not None:
        density = len(side_numbers) / ((hi - lo) / 2 + 1)
        if t_hi < min_inflation * hi or density < AUTO_MIN_DENSITY:
            return number  # TIGER's range is believable here
    eq = t_lo + (number - lo) / (hi - lo) * (t_hi - t_lo)
    eq = int(round(eq))
    if eq % 2 != number % 2:  # keep the parity so covering_range finds the right side
        eq += 1 if eq < t_hi else -1
    return min(max(eq, t_lo), t_hi)


def build(addresses, segments, candidates, parcels=None, ranges="tiger"):
    """Returns (address_df, candidate_df). Pure: takes the rows load()
    returns, so it's testable without a database.

    ranges='tiger': a number's place along the street comes from TIGER's
    address ranges. ranges='auto': the list's scale only where TIGER's
    range looks like a placeholder (AUTO_INFLATION). ranges='list': from its place among the list's own
    numbers on that street side (min..max of `addresses`) -- TIGER's
    numbers, often far wider than the real ones (Arrowhead Ridge Road:
    1-99 vs 1-9), are never used for scale."""
    seg_keys = ("label_street", "tlid", "lfromadd", "ltoadd", "rfromadd", "rtoadd", "geometry", "length_m",
                "dead_start", "dead_end", "fullname")
    segs_by_street = defaultdict(list)
    for row in segments:
        seg = dict(zip(seg_keys, row))
        seg["points"] = parse_linestring(seg["geometry"])
        segs_by_street[seg["label_street"]].append(seg)
    if FILL_MISSING_SIDE:
        for segs in segs_by_street.values():
            fill_missing_sides(segs)

    cand_keys = ("label_street", "source_id", "tlid", "side", "t", "at_end", "dist_m", "sqmeters", "occ_cls",
                 "prim_occ", "outbldg", "lat", "lon", "nearest_tlid", "nearest_dist_m", "via_lane")
    cands_by_street = defaultdict(list)
    for row in candidates:
        cand = dict(zip(cand_keys, row))
        cands_by_street[cand["label_street"]].append(cand)

    side_numbers = defaultdict(set)
    for _, number, street, *_rest in addresses:
        side_numbers[(street, number % 2)].add(number)
    side_numbers = {key: sorted(nums) for key, nums in side_numbers.items()}
    if RELIST_MIN_SHARE is not None:
        relist_streets(segs_by_street, side_numbers)

    address_rows, cand_rows = [], []
    for site_uid, number, street, method, lat, lon, true_id in addresses:
        street_segs = segs_by_street.get(street, [])
        if ranges == "tiger":
            range_number = number
        else:
            range_number = list_range_number(number, side_numbers[(street, number % 2)], street_segs,
                                             AUTO_INFLATION if ranges == "auto" else None)
        cover = covering_range(range_number, street_segs)
        addr = {"id": site_uid, "number": number, "range_number": range_number, "street": street, "match_method": method, "true_lat": lat, "true_lon": lon,
                "true_building": true_id, "scorable": cover is not None}
        if cover is None:
            address_rows.append(addr)
            continue
        seg, side, fraction, span = cover
        m0_lon, m0_lat = interpolate_along_line(seg["points"], fraction, OFFSET_FEET,
                                                "left" if side == "L" else "right")
        addr.update(m0_lat=m0_lat, m0_lon=m0_lon, cover_tlid=seg["tlid"], cover_side=side, f=fraction)
        address_rows.append(addr)
        cand_rows.extend(_candidates_for(addr, seg, side, fraction, span, street_segs, cands_by_street[street],
                                         parcels))

    address_df = pd.DataFrame(address_rows)
    candidate_df = pd.DataFrame(cand_rows)
    if not candidate_df.empty:
        candidate_df["label"] = (candidate_df["source_id"] == candidate_df["true_building"]).astype(int)
    return address_df, candidate_df


def _parcel_features(source_id, street_tlids, parcels) -> dict:
    """The building's lot: frontage (m) on this street's segments vs. on
    other streets', the share on this street, buildings on the lot, and
    whether this is the lot's biggest. NaN without a parcel."""
    info = parcels["buildings"].get(source_id) if parcels else None
    if info is None:
        return {"parcel_frontage_this": np.nan, "parcel_frontage_other": np.nan, "parcel_frontage_share": np.nan,
                "parcel_buildings": np.nan, "parcel_largest": np.nan, "parcel_area_m2": np.nan,
                "parcel_size_ratio": np.nan}
    front = parcels["frontage"].get(info["parcel"], {})
    this = sum(m for tlid, m in front.items() if tlid in street_tlids)
    other = sum(m for tlid, m in front.items() if tlid not in street_tlids)
    return {"parcel_frontage_this": this, "parcel_frontage_other": other,
            "parcel_frontage_share": this / (this + other) if this + other > 0 else np.nan,
            "parcel_buildings": info["buildings"], "parcel_largest": float(info["largest"]),
            "parcel_area_m2": info["area"],
            # This building's size vs. the lot's biggest: a shed is a small
            # fraction (12 Brickyard Cove's lot: 297 m2 house, 45 m2 shed).
            "parcel_size_ratio": info.get("size_ratio", np.nan) if info.get("size_ratio") is not None else np.nan}


def _canopy_features(source_id, parcels) -> dict:
    over, ring, width = (parcels or {}).get("canopy", {}).get(source_id, (None, None, None))
    nan = lambda v: np.nan if v is None else v
    return {"canopy_over": nan(over), "canopy_ring": nan(ring), "width_m": nan(width)}


def _driveway_features(source_id, street_names, parcels) -> dict:
    """drive_ratio: the cheapest pavement path to this street vs. to the
    easiest road (1 = this street is easiest); drive_best: this street is
    the easiest. NaN for buildings near the road (no driveway question) or
    when this street isn't among the building's nearby roads."""
    costs = (parcels or {}).get("driveways", {}).get(source_id)
    none = {"drive_ratio": np.nan, "drive_best": np.nan, "drive_off_m": np.nan, "drive_margin": np.nan}
    if not costs:
        return none
    mine = min((c for road, c in costs.items() if road in street_names), default=None)
    if mine is None:
        return none
    best = min(costs.values())
    offs = parcels.get("driveway_off", {}).get(source_id, {})
    off = min((o for road, o in offs.items() if road in street_names), default=np.nan)
    return {"drive_ratio": mine / best if best > 0 else 1.0, "drive_best": float(mine <= best),
            "drive_off_m": off, "drive_margin": mine - best}


def _access_distance(addr, source_id, d_m0, parcels) -> float:
    """Meters from the number's interpolated point (M0) to where the
    building's lot meets the street; d_m0 when there's no lot."""
    info = parcels["buildings"].get(source_id) if parcels else None
    point = parcels.get("access", {}).get((addr["street"], info["parcel"])) if info else None
    if point is None:
        return d_m0
    return float(haversine_m(addr["m0_lat"], addr["m0_lon"], point[0], point[1]))


def _candidates_for(addr, cover_seg, side, fraction, span, street_segs, street_cands, parcels=None):
    range_start = int(cover_seg["lfromadd" if side == "L" else "rfromadd"])
    street_tlids = {s["tlid"] for s in street_segs}
    street_names = {canonical(s.get("fullname")) for s in street_segs if s.get("fullname")}
    points_by_tlid = {s["tlid"]: s["points"] for s in street_segs}
    # Which ends are dead ends (unknown -- e.g. rows without the flags -- counts as one).
    dead_by_tlid = {s["tlid"]: (s.get("dead_start", True), s.get("dead_end", True)) for s in street_segs}
    by_building = defaultdict(list)
    for cand in street_cands:
        by_building[cand["source_id"]].append(cand)
    if not by_building:
        return []

    # Same-side buildings along the covering segment, in t order: the rank-
    # order (M2) view. t runs from the segment's first vertex, which is
    # where its `from` number sits, so rank fraction compares to f directly.
    on_side = sorted(
        (c for cands in by_building.values() for c in cands
         if c["tlid"] == cover_seg["tlid"] and c["side"] == side and not c["at_end"]),
        key=lambda c: (c["t"], c["source_id"]),
    )
    rank_frac = {c["source_id"]: (i + 0.5) / len(on_side) for i, c in enumerate(on_side)}
    implied_addresses = span / 2 + 1

    # Pass 1: each building's nearest segment of this street, and whether
    # it's past a dead end.
    info = {}
    for source_id, cands in by_building.items():
        # This building's nearest segment OF THIS STREET. A building by the
        # joint of two segments is equally near both: prefer the one it sits
        # alongside over one it only touches at an end, then the lowest tlid.
        best = min(cands, key=lambda c: (round(c["dist_m"], 2), bool(c["at_end"]), str(c["tlid"])))
        on_cover = next((c for c in cands if c["tlid"] == cover_seg["tlid"]), None)
        dead_start, dead_end = dead_by_tlid.get(best["tlid"], (False, False))
        at_dead_end = (best["t"] == 0 and dead_start) or (best["t"] == 1 and dead_end)
        past_end = all(c["at_end"] for c in cands) and at_dead_end and beyond_end(
            points_by_tlid.get(best["tlid"], []), best["t"], best["lat"], best["lon"])
        own_side = on_cover["side"] if on_cover else best["side"]
        info[source_id] = (best, on_cover, past_end, own_side)

    def dead_end_side(source_id):
        best, on_cover, _, own_side = info[source_id]
        if DEAD_END_SIDE == "axis":
            pts = points_by_tlid.get(cover_seg["tlid"] if on_cover else best["tlid"], [])
            return side_of_chord(pts, best["lat"], best["lon"]) if len(pts) >= 2 else own_side
        if DEAD_END_SIDE == "neighbors":
            others = sorted(
                (float(haversine_m(best["lat"], best["lon"], b["lat"], b["lon"])), sd)
                for sid, (b, _oc, pe, sd) in info.items() if sid != source_id and not pe and sd)
            sides = [sd for _, sd in others[:2]]
            return max(set(sides), key=sides.count) if sides else own_side
        return None  # "either"

    rows = []
    for source_id, cands in by_building.items():
        best, on_cover, past_end, own_side = info[source_id]
        if past_end:
            # Past the street's dead end: the line's last few meters can't
            # say which side it's on (DEAD_END_SIDE).
            decided = dead_end_side(source_id)
            same_side = True if decided is None else decided == side
        elif cover_seg.get("both_sides"):
            same_side = True  # relisted street, no TIGER side for this parity
        else:
            same_side = own_side == side
        if best.get("via_lane") and points_by_tlid.get(best["tlid"]):
            # A lane house sits where its lane meets the road (attach.LANE_SQL), not
            # where its roof is (123 Harpswell Neck Road: 917 m back down the lane).
            j_lon, j_lat = interpolate_along_line(points_by_tlid[best["tlid"]], best["t"])
            d_m0 = float(haversine_m(addr["m0_lat"], addr["m0_lon"], j_lat, j_lon))
        else:
            d_m0 = float(haversine_m(addr["m0_lat"], addr["m0_lon"], best["lat"], best["lon"]))
        rows.append({
            "address_id": addr["id"],
            "street": addr["street"],
            "source_id": source_id,
            "true_building": addr["true_building"],
            "lat": best["lat"], "lon": best["lon"],
            # --- features ---
            "d_m0": d_m0,
            "on_cover_segment": on_cover is not None,
            "same_side": same_side,
            "beyond_end": past_end,
            "dt": abs(on_cover["t"] - fraction) * cover_seg["length_m"] if on_cover else np.nan,
            # Raw "how far along" vs "how many numbers along" from the range's
            # start: lets the model learn the local numbering density instead
            # of assuming the range is spread evenly over the segment (M0).
            "pos_m": on_cover["t"] * cover_seg["length_m"] if on_cover else np.nan,
            "numbers_from_start": abs(addr["range_number"] - range_start),
            "meters_per_number": (on_cover["t"] * cover_seg["length_m"] / abs(addr["range_number"] - range_start)
                                  if on_cover and addr["range_number"] != range_start else np.nan),
            "rank_gap": abs(rank_frac[source_id] - fraction) if source_id in rank_frac else np.nan,
            "buildings_on_side": len(on_side),
            "implied_addresses": implied_addresses,
            "dist_road": best["dist_m"],
            "at_end": bool(best["at_end"]),
            "nearest_road_is_street": best["nearest_tlid"] in street_tlids,
            "dist_vs_nearest_road": best["dist_m"] - best["nearest_dist_m"],
            "sqmeters": best["sqmeters"],
            "residential": best["occ_cls"] == "Residential",
            "single_family": best["prim_occ"] == "Single Family Dwelling",
            "outbldg_flag": bool(best["outbldg"]),
            "segment_length_m": cover_seg["length_m"],
            "match_exact": addr["match_method"] == "exact",
            **_parcel_features(source_id, street_tlids, parcels),
            "pool_m": (parcels or {}).get("pools", {}).get(source_id, np.nan),
            **_canopy_features(source_id, parcels),
            **_driveway_features(source_id, street_names, parcels),
            "d_m0_access": _access_distance(addr, source_id, d_m0, parcels),
        })

    rows.sort(key=lambda r: r["d_m0"])
    rows = rows[:MAX_CANDIDATES]
    # Bigger building closer to the road, nearby: likely this one's garage/barn.
    for r in rows:
        r["bigger_in_front"] = any(
            o is not r and o["sqmeters"] and r["sqmeters"] and o["sqmeters"] > r["sqmeters"]
            and o["dist_road"] < r["dist_road"]
            and haversine_m(r["lat"], r["lon"], o["lat"], o["lon"]) <= OUTBUILDING_RADIUS_M
            for o in rows
        )
    for i, r in enumerate(rows):
        r["d_m0_rank"] = i
    return rows


FEATURES = [
    "d_m0", "d_m0_rank", "on_cover_segment", "same_side", "dt", "rank_gap", "buildings_on_side",
    "implied_addresses", "pos_m", "numbers_from_start", "meters_per_number", "dist_road", "at_end", "nearest_road_is_street", "dist_vs_nearest_road",
    "sqmeters", "residential", "single_family", "outbldg_flag", "bigger_in_front", "segment_length_m",
    "match_exact", "beyond_end",
    "parcel_frontage_this", "parcel_frontage_other", "parcel_frontage_share", "parcel_buildings",
    "parcel_largest", "parcel_area_m2", "parcel_size_ratio", "pool_m",
]
# canopy_over / canopy_ring / width_m (canopy.py) are computed for road
# order's tree-covered rule but are not model inputs: as inputs they cost
# TIGER 0.7 and E911 roads 1.2 points (Freeport, 2026-11-07).
# drive_ratio / drive_best (driveways.py) are computed for road order's
# driveway rules but are not model inputs: as inputs they cost TIGER 1.2
# points; as rules (order.DRIVEWAY_CLEAR_RATIO) they add a point on E911 roads.
# d_m0_access (distance from M0 to where the building's lot meets the
# street) is computed but not a model input: it fixed 48 Flying Point Road
# on E911 roads but cost 0.3-0.9 points town-wide.


def baseline_picks(candidate_df) -> dict:
    """{method: {address_id: source_id}} for the geometry baselines.
    M1: nearest building to M0 on the address's side (any side if none).
    M2: same-side building on the covering segment whose rank order best
        fits the number's place in the range (M1 if none ranked).
    M3: M2, skipping likely outbuildings (small, or a bigger building in
        front)."""
    picks = {"M1": {}, "M2": {}, "M3": {}}
    for address_id, group in candidate_df.groupby("address_id", sort=False):
        same = group[group["same_side"]]
        m1 = (same if not same.empty else group).sort_values("d_m0").iloc[0]["source_id"]
        picks["M1"][address_id] = m1
        ranked = group.dropna(subset=["rank_gap"])
        picks["M2"][address_id] = ranked.sort_values("rank_gap").iloc[0]["source_id"] if not ranked.empty else m1
        houses = ranked[(ranked["sqmeters"].fillna(0) >= 60) & ~ranked["bigger_in_front"]]
        picks["M3"][address_id] = (
            houses.sort_values("rank_gap").iloc[0]["source_id"] if not houses.empty else picks["M2"][address_id]
        )
    return picks

