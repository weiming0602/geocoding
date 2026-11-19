"""House numbers run in order along the road: on one side of a street,
higher numbers sit farther along it (Freeport E911: 98.7% of same-side
pairs). The ranker scores each address alone, so two addresses can claim
one building and 22 can land past 42. This step takes the ranker's
per-address probabilities and, per street and parity, picks the
assignment with the highest total probability such that every building
serves at most one number and numbers increase along the road.

Which way the numbers run is chosen by whichever direction scores higher
-- E911 locations are never used. What it does need is the LIST of numbers
on the street (here, the E911 addresses being scored); outside E911 areas
that has to come from somewhere else (a batch file, assessor records, the
National Address Database).
"""

from collections import Counter, defaultdict

import math

import numpy as np
import pandas as pd
import psycopg

from .street_lines import street_lines

# Distance along each Stage 1b street, merged into one line
# (street_lines.py: forks' short spurs trimmed, gaps chained -- before that,
# such streets got no positions and kept the ranker's own picks).
POSITIONS_SQL = """
WITH lines AS (SELECT street, g FROM street_lines)
SELECT l.street, st.source_id,
       ST_LineLocatePoint(l.g, st.inner_point) * ST_Length(l.g::geography)
FROM lines l
JOIN address_inference.structures st
  ON st.state_fips = %(state_fips)s AND st.inner_point && ST_Expand(l.g, 0.003)
WHERE ST_GeometryType(l.g) = 'ST_LineString'
"""


# Streets are processed from the most important road down, and a building
# one street's numbers take can't be taken by a later street: a corner
# house addressed on the main road (173 Flying Point Road) stops being a
# candidate for the side street (Arrowhead Ridge Road). Rank by road class
# -- TIGER MTFCC codes or E911 RDCLASS names -- then by how many addresses
# the street has (TIGER marks nearly every town street S1400).
ROAD_CLASS_RANK = {
    "S1100": 0, "Primary": 0,
    "S1200": 1, "Secondary": 1,
    "S1400": 2, "Local": 2,
    "S1730": 3, "S1740": 3, "Private": 3,
}
UNKNOWN_CLASS_RANK = 4
# A building that another street is at least this many meters closer to
# is off limits to this street in the assignment (None = no limit): the
# corner house of 173 Flying Point Road is 35 m from Flying Point and 77 m
# from Arrowhead Ridge Road, so Arrowhead's 4 can't take it.
OTHER_ROAD_CLOSER_M = 25

# A building under this share (0.2) of the biggest building on its tax lot is an
# accessory -- shed, garage -- and takes no number in the assignment (None =
# no limit). E911 addresses only 15% of them in Freeport; left in, one could
# take a number and push the street's other numbers along (12 Brickyard
# Cove's 45 m2 shed next to its 297 m2 house).
ACCESSORY_MAX_RATIO = 0.2
# A building this big (m2) is never an accessory, whatever the lot's biggest
# (None = off): on the Bowdoin campus lot at Bayview Road's end (12 buildings,
# a 658 m2 lab) 250's 124 m2 cottage counted as a shed and 250-283 shifted.
ACCESSORY_MIN_M2 = None
# A place whose biggest lidar roof (lidar.py) is under this many m2 is no
# house and takes no number, like a shed (None = off): a 36 m2 outbuilding
# on a 5-building lot took 50 Webster Road and shifted 52-58 one house on.
# Buildings lidar never measured are kept. Off: Freeport right building,
# TIGER 53.3% (off) / 53.1 (30 m2) / 52.6 (50) / 52.1 (60), E911 roads 66.0 /
# 65.8 / 65.7 / 64.1, and Webster Road stays shifted -- the ranker itself
# leans one house on there (58: 0.17 on 54's house, 0.07 on its own).
SMALL_ROOF_M2 = None
# A footprint lidar measured and found no roof on is no house and takes no
# number (False = off). Webster Road's 46 is a 71 m2 outline with nothing
# in the 2020 lidar. Off: 83 of Freeport's 320 no-roof footprints are
# E911-numbered houses (low or flat roofs, thin coverage); right building
# TIGER 53.3% -> 52.8%, E911 roads 66.0% -> 65.0%; Webster Road unchanged.
NO_ROOF = False
# Narrower (owner's eye on Webster Road's south building: open ground, no
# driveway): no lidar roof, not under trees (canopy_over < TREE_COVERED) and
# an outline under this many m2 -- 91 of Freeport's 99 such footprints are
# not E911 houses; bigger ones are mostly houses built after the 2020
# flight. Off: right building TIGER 53.3 -> 53.2 (80 or 100 m2) / 52.9
# (120), E911 roads 66.0 -> 65.7 / 65.6 / 65.3. On Webster Road it breaks
# 48: E911's 46 has no building near its point, and with the south footprint
# gone, 46 takes 48's house instead -- the footprint was harmlessly holding 46.
NO_ROOF_SMALL_M2 = None

# A number with at least this many E911 points is a big complex (141 Main
# Street: 563 points, one building). It keeps the ranker's own pick and
# that building is off limits to the street's other numbers, so one
# doubtful building earlier on the street can't shift it along with every
# ordinary house (None = off).
LOCK_MIN_POINTS = 50

# Driveway evidence from aerial imagery (driveways.py), used as road-order
# rules rather than model inputs: as inputs it cost TIGER 1.2 points.
DRIVEWAY_RULES = True
DRIVEWAY_CLEAR_RATIO = 1.5
# Never drop a building from a street its driveway visibly reaches (<= LANE_MAX_OFF_M off pavement), even
# when another road is cheaper to reach (owner, 89 Allen Point Road, Harpswell: fully paved driveway to
# Allen Point Road, but Red Fox Run's line passes 42 m from the house). None/False = off.
DRIVEWAY_KEEP_VISIBLE = False
DRIVEWAY_CORNER_RATIO = 3.0
DRIVEWAY_SET_BACK_M = 40
# ...and only when this street is at least this much costlier in absolute terms
# (path cost ~ meters): a corner house 1 vs 4 from two roads is a 4x "ratio" but
# no evidence (Harpswell: 297 E911 houses dropped as "driveway to another road",
# most of them corners like 1 Anns Place, 199 Ash Point Road). 0 = ratio only.
DRIVEWAY_MIN_MARGIN = 100  # 0 / 25 / 50 / 100 tested 2026-11-12: 100 best -- Harpswell 51.79 -> 52.06, Freeport 56.73 -> 56.91, Pownal 46.08 -> 46.24, Topsham and New Gloucester unchanged

POOL_HOME_M = 15
# Owner's rule: a long lane you can see in the imagery is expensive -- nobody
# builds one to a barn. The building at its end (from LANE_MIN_M+ back, its
# driveway nearly all pavement or gravel: off it at most LANE_MAX_OFF_SHARE
# of the distance back, never under LANE_MAX_OFF_M -- tree shadows break a
# long lane here and there) is the home: never a shed or an extra, its lot's
# numbered building, and LANE_BONUS more likely for the street its lane joins
# (48 Flying Point Road: 226 m back, 10 m of gaps). LANE_BONUS None = off.
# Adopted as the foundation even though Freeport scores dip (owner's call,
# 2026-11-07): imagery first, then review the changed cases.
# A building whose outline is at least this share under trees (canopy.py)
# was traced short (42 Flying Point Road: 31%, a thin 78 m2 strip): never a
# shed or a "much smaller extra" for its size. None = off.
TREE_COVERED = 0.2
LANE_MIN_M = 100
LANE_MAX_OFF_M = 10
LANE_MAX_OFF_SHARE = 0.1
LANE_BONUS = 0.3
POOL_BONUS = 0.0

# A street only claims a building it's this sure of (the ranker's
# probability for that pair): a wrong claim on a main road would otherwise
# push every number on the side street off by one (165 Flying Point Road
# taking an Arrowhead Ridge Road house).
CLAIM_MIN_P = 0.3
# lot_picks: a place another street's address wants with at least this
# probability (and more than this address does) is that street's -- unless
# the place's building has its driveway on THIS street. Freeport: TIGER
# 53.3% -> 54.0% (46 numbers fixed, 23 broken), E911 roads 66.1% -> 66.2%
# (38/34). Without the driveway guard it lost 0.5 on E911 roads; also
# requiring this address to have wanted the lot (p >= 0.05) lost 0.6 there.
LOT_RESERVE_P = 0.5
LOT_RESERVE_MIN_P = 0.0

STREET_CLASS_SQL = """
SELECT sms.label_street, array_agg(DISTINCT s.mtfcc)
FROM address_inference.street_match_segments sms
JOIN address_inference.streets_ext s ON s.tlid = sms.tlid
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
GROUP BY sms.label_street
"""


def load_street_classes(dsn, region, town) -> dict:
    """{street: best (lowest) class rank among its matched segments}."""
    params = {"region": region.id, "town": town}
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(STREET_CLASS_SQL, params).fetchall()
    return {street: min((ROAD_CLASS_RANK.get(c, UNKNOWN_CLASS_RANK) for c in classes), default=UNKNOWN_CLASS_RANK)
            for street, classes in rows}


def street_priority(address_df, street_classes) -> list:
    """Streets in processing order: road class, then most addresses first."""
    counts = address_df[address_df["scorable"]].groupby("street").size()
    return sorted(counts.index,
                  key=lambda st: (street_classes.get(st, UNKNOWN_CLASS_RANK), -counts[st], st))


# Where each tax lot touches each street: the middle of the street's
# stretch within LOT_FRONTAGE_M of the lot. Lots, not houses, are numbered
# in order (the owner's matrix rule): Brickyard Cove's lots front the road
# at 77, 190, 300 and 371 m -- 12, 22, 42, 44 in order -- while 22's house,
# deep behind lot 42, projects to 336 m, after lot 42's front house (315 m).
LOT_FRONTAGE_M = 15
LOT_POSITIONS_SQL = f"""
WITH lines AS (SELECT street, g FROM street_lines), touch AS (
    SELECT l.street, p.parcel_id,
           ST_LineLocatePoint(l.g, ST_Centroid(ST_Intersection(l.g, ST_Buffer(p.geom::geography, {LOT_FRONTAGE_M})::geometry)))
             * ST_Length(l.g::geography) AS along,
           -- the ends of the lot's stretch of street
           (SELECT min(ST_LineLocatePoint(l.g, d.geom)) FROM ST_DumpPoints(ST_Intersection(l.g,
               ST_Buffer(p.geom::geography, {LOT_FRONTAGE_M})::geometry)) d) * ST_Length(l.g::geography) AS lo,
           (SELECT max(ST_LineLocatePoint(l.g, d.geom)) FROM ST_DumpPoints(ST_Intersection(l.g,
               ST_Buffer(p.geom::geography, {LOT_FRONTAGE_M})::geometry)) d) * ST_Length(l.g::geography) AS hi
    FROM lines l
    JOIN address_inference.parcels p
      ON p.state_fips = %(state_fips)s AND p.town = %(town)s AND p.geom && ST_Expand(l.g, 0.0003)
     AND ST_DWithin(p.geom::geography, l.g::geography, {LOT_FRONTAGE_M})
    WHERE ST_GeometryType(l.g) = 'ST_LineString'
)
SELECT t.street, bp.source_id, t.along,
       -- how far back the building sits from this street
       ST_Distance(l.g::geography, b.inner_point::geography) AS back_m, t.lo, t.hi
FROM touch t JOIN address_inference.building_parcels bp ON bp.parcel_id = t.parcel_id
JOIN lines l ON l.street = t.street
JOIN address_inference.structures b ON b.state_fips = bp.state_fips AND b.source_id = bp.source_id
WHERE t.along IS NOT NULL
  -- ordinary lots only: a condo parcel's buildings keep their own positions
  AND (SELECT count(*) FROM address_inference.building_parcels b2 WHERE b2.parcel_id = t.parcel_id) <= {{max_buildings}}
ORDER BY t.street, bp.source_id
"""


# Owner's rule: the lot-column numbering (deep lots numbered across, in
# columns along the road) belongs to dead ends that run down to the water,
# like Brickyard Cove (its end is 62-76 m from the shore), not to ordinary
# streets. A street qualifies when an end touches no other road and lies
# within COASTAL_END_M of the shoreline (address_inference.coastline).
COASTAL_END_M = 150
DEEP_LOT_M = 50
COASTAL_DEAD_ENDS_SQL = f"""
WITH lines AS (SELECT street, g FROM street_lines), ends AS (
    SELECT street, g, ST_StartPoint(g) AS p, ST_LineInterpolatePoint(g, 0.01) AS inner_p FROM lines
    WHERE ST_GeometryType(g) = 'ST_LineString'
    UNION ALL
    SELECT street, g, ST_EndPoint(g), ST_LineInterpolatePoint(g, 0.99) FROM lines
    WHERE ST_GeometryType(g) = 'ST_LineString'
)
SELECT DISTINCT e.street FROM ends e
WHERE NOT EXISTS (SELECT 1 FROM streets o WHERE o.geom && ST_Expand(e.p, 0.0001)
                    AND ST_DWithin(o.geom::geography, e.p::geography, 2)
                    AND NOT ST_DWithin(o.geom::geography, e.inner_p::geography, 1))
  AND EXISTS (SELECT 1 FROM address_inference.coastline c
               WHERE c.geom && ST_Expand(e.p, 0.003) AND ST_DWithin(c.geom::geography, e.p::geography, {COASTAL_END_M}))
"""


def coastal_dead_ends(conn, params) -> set:
    if conn.execute("SELECT to_regclass('address_inference.coastline') IS NULL").fetchone()[0]:
        return set()
    return {street for (street,) in conn.execute(COASTAL_DEAD_ENDS_SQL, params).fetchall()}


# Where each set-back building's driveway meets the street (driveways.py's
# entry point), as meters along the street. Only entries on (within
# ENTRY_SNAP_M of) the street line count; the caller checks the entry's
# road is this street.
ENTRY_POSITIONS_SQL = """
WITH lines AS (SELECT street, g FROM street_lines), entries AS (
    SELECT d.source_id, d.road, ST_SetSRID(ST_MakePoint(d.entry_lon, d.entry_lat), 4326) AS pt
    FROM address_inference.building_driveways d
    WHERE d.state_fips = %(state_fips)s AND d.entry_lat IS NOT NULL
      -- a visible driveway: (nearly) all of the path on pavement
      AND d.off_m <= %(max_off)s
)
SELECT l.street, e.source_id, e.road,
       ST_LineLocatePoint(l.g, e.pt) * ST_Length(l.g::geography) AS along,
       ST_Distance(l.g::geography, b.inner_point::geography) AS back_m
FROM lines l
JOIN entries e ON e.pt && ST_Expand(l.g, 0.0005) AND ST_DWithin(e.pt::geography, l.g::geography, %(snap)s)
JOIN address_inference.structures b ON b.state_fips = %(state_fips)s AND b.source_id = e.source_id
WHERE ST_GeometryType(l.g) = 'ST_LineString'
ORDER BY l.street, e.source_id
"""
ENTRY_SNAP_M = 30
ENTRY_MAX_OFF_M = 10
# Buildings at least this far back from a street take their position along
# it from their driveway's entry. None = off: Freeport, every driveway at
# 50 m+ back cost TIGER 1.1 / E911 roads 0.8 points; visible driveways only
# (<= ENTRY_MAX_OFF_M off pavement), 80 m+ back, tied (TIGER 54.0% -> 54.0%,
# E911 roads 66.2% -> 66.1%) -- deep lots already sit where their tax lot
# meets the road, usually where the driveway is. Possibly useful where
# there are no parcels (NH).
ENTRY_MIN_BACK_M = None


# Owner's rule: reference the tax lot before numbering. "within" = coastal
# dead ends and deep houses as "coastal", and every other building's own
# place kept inside its lot's stretch of the street. Freeport, right
# building: TIGER 53.3% (coastal) / 53.3% (within) / 53.1% (True: every lot's
# frontage middle); E911 roads 66.4 / 66.4 / 66.1.
BY_LOT = "within"


LANE_POSITIONS = True
LANE_POSITIONS_SQL = """
SELECT DISTINCT ON (sms.label_street, bs.source_id) sms.label_street, bs.source_id,
       ST_LineLocatePoint(l.g, ST_LineInterpolatePoint(s.geom, bs.t)) * ST_Length(l.g::geography)
FROM address_inference.building_segments bs
JOIN address_inference.street_match_segments sms ON sms.tlid = bs.tlid
JOIN address_inference.streets_ext s ON s.tlid = bs.tlid
JOIN street_lines l ON l.street = sms.label_street
WHERE bs.state_fips = %(state_fips)s AND bs.rank = 99
  AND sms.region_id = %(region)s AND sms.town = %(town)s
ORDER BY sms.label_street, bs.source_id, bs.dist_m
"""


def load_positions(dsn, region, town, by_lot=BY_LOT, entry_min_back_m=None, entry_max_off_m=None) -> dict:
    """{(street, source_id): meters along the street}. by_lot: on which
    streets a building on an ordinary tax lot that fronts the street takes
    the lot's frontage position (LOT_POSITIONS_SQL) instead of its own
    projection -- "coastal" (dead ends near the shore), "within" (coastal, and
    elsewhere the projection kept inside the lot's frontage), True (all), False."""
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        rows = conn.execute(POSITIONS_SQL, params).fetchall()
        out = {(street, source_id): along for street, source_id, along in rows}
        if by_lot and not conn.execute("SELECT to_regclass('address_inference.building_parcels') IS NULL").fetchone()[0]:
            only = coastal_dead_ends(conn, params) if by_lot in ("coastal", "within") else None
            sql = LOT_POSITIONS_SQL.replace("{max_buildings}", str(LOT_MAX_BUILDINGS))
            for street, source_id, along, back_m, lo, hi in conn.execute(sql, params).fetchall():
                # Coastal dead ends (lots numbered in columns), and anywhere a
                # house sits far back at the end of a long driveway: its
                # number belongs where its lot -- the driveway -- meets the
                # road (48 Flying Point Road: house 226 m back, lot meets the
                # road ~87 m before the house projects onto it).
                deep = back_m is not None and back_m >= DEEP_LOT_M
                if (street, source_id) not in out:
                    continue
                if only is None or street in only or deep:
                    out[(street, source_id)] = along
                elif by_lot == "within" and lo is not None:
                    # elsewhere the building's own place, kept inside its
                    # lot's stretch of the street
                    out[(street, source_id)] = min(max(out[(street, source_id)], lo), hi)
        if LANE_POSITIONS:
            # A lane house (attach.LANE_SQL, rank 99) sits where its lane meets the
            # street, not straight across from its roof (33 Williams Road: lane joins
            # at ~245 m, the roof projects to 364 m, past 39's house).
            for street, source_id, along in conn.execute(LANE_POSITIONS_SQL, params).fetchall():
                if (street, source_id) in out and along is not None:
                    out[(street, source_id)] = along
        min_back = ENTRY_MIN_BACK_M if entry_min_back_m is None else entry_min_back_m
        if min_back is not None and not conn.execute(
                "SELECT to_regclass('address_inference.building_driveways') IS NULL").fetchone()[0]:
            from .street_names import canonical
            for street, source_id, road, along, back_m in conn.execute(
                    ENTRY_POSITIONS_SQL, {**params, "snap": ENTRY_SNAP_M,
                                          "max_off": ENTRY_MAX_OFF_M if entry_max_off_m is None else entry_max_off_m}).fetchall():
                # The house's number belongs where its driveway meets the road
                # (48 Flying Point Road: 226 m back, its lane enters the road
                # well before the house projects onto it).
                if ((street, source_id) in out and back_m is not None and back_m >= min_back
                        and canonical(street) == road):
                    out[(street, source_id)] = along
    return out


# Neighboring numbers may share one building (duplexes, small multi-unit
# houses: 349 of Freeport's 3,731 numbers, in 152 buildings) at this cost.
# Strict one-number-per-building pushed every later number on that side
# off by one.
SHARE_PENALTY = 1.0  # 2026-11-13 Harpswell (headline count): inf 2,376 | 0.3 2,262 | 0.6 2,372 | 1.0 2,387 -- Basin Cove 74/82 share a building; strict one-per-building shifted the even side


# Townhouses (Harvest Ridge Road: 18-19-20, 23-25, 26-28 ... one building
# each): on a street side with at least TOWNHOUSE_RATIO times as many
# numbers as buildings whose nearest road is this street, consecutive
# numbers may share a building, at TOWNHOUSE_SHARE_PENALTY each.
TOWNHOUSE_RATIO = 1.5
TOWNHOUSE_SHARE_PENALTY = 0.1
# In townhouse mode the side's numbers are dealt out to its home buildings
# in road order, in equal shares (12 numbers, 6 buildings: two each); a
# number on its slot's building gets this bonus on top of the ranker's
# probability. The ranker's own interpolation-based scores can't do this:
# where the houses start well into the road (Harvest Ridge Road: 165 m),
# every number is expected too early and lands one building short.
TOWNHOUSE_SLOT_BONUS = 1.0
# ...and only where the side's numbers run in sequence (at least this share
# of the parity's slots between its lowest and highest number are taken):
# townhouse rows are numbered 26, 28, 30, 32...; rural roads jump.
TOWNHOUSE_MIN_DENSITY = 0.8
# ...and only where the side's home buildings are big enough to hold several
# homes (median outline m2; None = any size). Juniper Drive's mobile homes
# (67-114 m2; two of them missing from the footprints) looked like a
# townhouse row -- 4 odd numbers, 2 buildings -- and took two numbers each;
# real townhouse rows (Harvest Ridge, Chase Court, Unity Lane, Gideons Way)
# are 137 m2 and up. Off: Freeport neutral (135 m2: ML + road order TIGER
# 55.8% -> 56.0%, E911 roads 67.8% -> 68.0%; assessor 80.5% -> 80.4%, 83.7%
# -> 83.5%) and Juniper isn't fixed -- with two houses missing, its odd side
# shifts one house instead of doubling up. Missing footprints, not order.
TOWNHOUSE_MIN_M2 = None
# More home buildings than numbers on a side (owner's rule): the extra
# buildings belong to someone's property. The side's home buildings are
# split, in road order, at the k-1 widest gaps into k properties (k =
# numbers), number i's property gets this bonus, and the ranker picks the
# building inside it. 0 = off.
PROPERTY_SLOT_BONUS = 0.1  # stronger hurts: widest gaps often aren't lot lines
# Owner's rule, size + count together: on a rural side (median lot of its
# home buildings >= RURAL_MIN_LOT_M2) with more home buildings than numbers,
# the extra ones are the smallest -- but only those at least
# EXTRA_SIZE_FACTOR times smaller than the side's median building count as
# extras (sheds, garages). The smallest buildings alone are real houses
# about half the time (camps, cottages); at 2x smaller, a quarter; at 3x, a
# sixth. They get EXTRA_SMALL_PENALTY (inf = left out; firm was worse); None = off.
EXTRA_SMALL_PENALTY = 0.3
EXTRA_SIZE_FACTOR = 2.0
RURAL_MIN_LOT_M2 = 4000
# Which size says "smallest": "outline" (footprint, cut short by trees) or
# "lidar" (lidar.py's whole roof where measured, else the outline);
# RURAL_MIN_LOT_M2 = None applies the rule on every street. Owner's idea
# (more buildings than numbers: keep the better-sized, leave the smallest),
# Freeport right building TIGER / E911 roads, ML + road order:
#   today (outline, rural, <= half median, 0.3)     53.3 / 66.0
#   lidar size, same conditions                     53.1 / 65.7
#   lidar, every street                             53.0 / 65.7
#   lidar, every street, any surplus, 0.3           52.1 / 65.3
#   lidar, every street, any surplus, left out      49.4 / 63.7
#   lidar, rural, any surplus, left out             50.4 / 64.1
# The smallest surplus buildings are often the real houses (camps,
# cottages); Webster Road 50-58 stayed shifted in every variant.
EXTRA_SIZE = "outline"
# Owner's idea: on a side with more buildings than numbers, deal the numbers
# out from one end -- "max": the highest number to the last building along
# the road, the next to the one before..., so the leftover buildings fall
# at the low end ("min": the other way). Number i's slot gets END_SLOT_BONUS.
# Off (0): right building TIGER / E911 roads, today 53.3 / 66.0; from max
# 0.05: 53.3 / 66.0, 0.1: 52.7 / 66.0, 0.2: 50.6 / 65.3, 0.4: 47.9 / 64.8;
# from min 0.05: 53.2 / 65.8, 0.4: 48.7 / 63.8. Webster Road unchanged.
END_SLOT_FROM = "max"
END_SLOT_BONUS = 0.0
END_SLOT_HOMES = True   # count only home buildings (their nearest road is this street)


# A building holds at most this many numbers of one parity (owner's rule:
# a townhouse building on one side has one or two numbers; a gap in the
# numbers is where the next building starts).
MAX_PER_BUILDING = 2


def lane_end(df) -> pd.Series:
    """Rows whose building sits at the end of a visible lane to this street."""
    if LANE_BONUS is None or not {"drive_best", "drive_off_m", "dist_road"} <= set(df.columns):
        return pd.Series(False, index=df.index)
    allowed = np.maximum(LANE_MAX_OFF_M, LANE_MAX_OFF_SHARE * df["dist_road"])
    # DRIVEWAY_KEEP_VISIBLE: a visible lane to this street counts even when another road is cheaper to reach
    # (89 Allen Point Road: paved 209 m lane to Allen Point Road, Red Fox Run's line 42 m away)
    best = True if DRIVEWAY_KEEP_VISIBLE else (df["drive_best"] == 1)
    return (best & (df["drive_off_m"] <= allowed)
            & (df["dist_road"] >= LANE_MIN_M)).fillna(False).astype(bool)


# What leaving a number unplaced scores (scores are log-probabilities; None
# = 0, free). Free, the cheapest answer could shift a whole run one house on
# and drop its last number: E911 roads, Lower Mast Landing Road 45 -> 47's
# house, 47 -> 51's, ... 59 -> 63's, 63 unplaced.
# Freeport, right building with an unplaced number scored as log(p):
# free 53.3 / 66.0 (TIGER / E911 roads); p=0.3 50.1 / 64.4; p=0.03 48.8 /
# 62.3 -- many numbers really have no house among the candidates (units,
# geocoded points, houses past 200 m). Off; the assessor mode's anchors
# (assessor_picks) fix that run instead.
SKIP_SCORE = None
# Owner's count rule (2026-11-18, High Head Road, Harpswell: TIGER's odd 199-245 piece ends a few houses early;
# road order dropped 215 and 227-291 each took the house before theirs). Between two numbers road order placed
# with confidence (probability >= COUNT_ANCHOR_P) on a street side, when the run is mismatched -- a number left
# out, two numbers on one place, or a home place left empty -- and its home places equal its numbers, the k-th
# number takes the k-th place in road order. Every pair must be a candidate. False = off.
COUNT_RUNS = True  # on 2026-11-19: 7 towns, drop_and_empty trigger: Harpswell +9, New Gloucester +1, others 0, none broke
COUNT_TRIGGER = "drop_and_empty"  # "any" (also two numbers on one place): Topsham -18, Gray -3; "drop_and_empty": only a run with a number left out and a house left empty
COUNT_EXTRA_MAX = 0  # runs with up to this many more home places than numbers (all numbers placed)
COUNT_ANCHOR_P = 0.7  # 0.5: wrong picks (227, 291 at ~0.6) became anchors and nothing fired; 0.8: too sparse
LAST_COUNTED: list = []  # (street, numbers) runs the count rule renumbered


def count_runs(mapping, numbers, order, direction, street, positions, home, prob) -> dict:
    """mapping {number: place} for one street side -> the same with mismatched runs between confident numbers
    renumbered in house order (owner's count rule)."""
    out = dict(mapping)
    idx = {b: i for i, b in enumerate(order)}
    conf = sorted(n for n, b in mapping.items() if (n, b) in prob and np.mean(prob[(n, b)]) >= COUNT_ANCHOR_P)
    for a, z in zip(conf, conf[1:]):
        ia, iz = idx.get(mapping[a]), idx.get(mapping[z])
        if ia is None or iz is None or iz - ia < 2:
            continue
        run_n = [n for n in numbers if a < n < z]
        run_b = [b for b in order[ia + 1:iz] if (street, b) in home]
        extra = len(run_b) - len(run_n)
        if not run_n or extra < 0 or extra > COUNT_EXTRA_MAX:
            continue
        used = [mapping.get(n) for n in run_n]
        placed = [u for u in used if u]
        if COUNT_TRIGGER == "drop_and_empty":
            # High Head's signature: a number left out AND a house left empty in the same run. Two numbers on one
            # place alone is normal where a number has no footprint (Topsham's Cathance Road 369 shares 377's
            # house): renumbering those runs slid right numbers one house (Eider Lane -10, Cathance -8).
            mismatched = any(u is None for u in used) and any(b not in used for b in run_b)
        else:
            mismatched = (any(u is None for u in used) or len(set(placed)) < len(placed)
                          or (extra == 0 and any(b not in used for b in run_b)))
        if not mismatched:
            continue
        if extra == 0:
            if any((n, b) not in prob for n, b in zip(run_n, run_b)):
                continue
            new = dict(zip(run_n, run_b))
        else:
            # a few more houses than numbers: every number placed, in house order; the ranker's scores pick which
            # houses stay empty (owner: "we don't drop street number easily")
            P = np.array([[np.log(np.mean(prob[(n, b)]) + 1e-9) if (n, b) in prob else -1e9 for b in run_b]
                          for n in run_n])
            _, match = monotone_assign(P, share_penalty=np.inf, skip_score=-1e9)
            if len(match) != len(run_n) or any(P[i, j] <= -1e8 for i, j in match.items()):
                continue
            new = {run_n[i]: run_b[j] for i, j in match.items()}
        out.update(new)
        LAST_COUNTED.append((street, tuple(run_n)))
    return out
# Owner: "street numbers along buildings are supposed to be in order". A number road order left unplaced falls
# back only to a house between its placed neighbors' houses on that side; with none there it stays unplaced.
ORDERED_FALLBACK = False

# Bayview Road 220: its E911 point is the campus entrance, no building within
# 156 m; road order gave it 246's house and every number after it slid one
# house on. A number whose nearest same-side candidate is more than this far
# from its interpolated point (d_m0) is left unplaced -> review. None = off.
NO_HOUSE_NEAR_M = None
# What "near" is measured from: "d_m0" (TIGER's interpolated point -- too often
# wrong, 2026-11-14) or "d_rate_len" (rate_spots: the addresser's spot from the
# road's start, meters along the road).
NO_HOUSE_NEAR_BY = "d_m0"


def monotone_assign(P, share_penalty=None, max_per_building=None, skip_score=None):
    """P[i, j]: score for number i (ascending) on building j (in road
    order). Returns (total, {i: j}) maximizing the summed score over
    assignments where buildings never go backwards along the road; a number
    may stay unmatched, and up to `max_per_building` consecutive numbers
    may share a building, each extra one costing `share_penalty` (None =
    SHARE_PENALTY; inf = strictly one number per building)."""
    penalty = SHARE_PENALTY if share_penalty is None else share_penalty
    skip = SKIP_SCORE if skip_score is None else skip_score
    skip = 0.0 if skip is None else skip
    k, m = P.shape
    pen = np.broadcast_to(np.asarray(penalty, dtype=float), (m,))  # per building (scalar = all)
    cap = (MAX_PER_BUILDING if max_per_building is None else max_per_building) if np.isfinite(pen).any() else 1
    NEG = -np.inf
    # D[i, j]: best for numbers < i using buildings < j.
    # M[c, i, j]: best for numbers < i with number i-1 the (c+1)-th number on building j-1.
    D = np.zeros((k + 1, m + 1))
    M = np.full((cap, k + 1, m + 1), NEG)
    back_d = np.zeros((k + 1, m + 1), dtype=np.int8)  # 0 skip number, 1 skip building, 2+c from M[c]
    for i in range(1, k + 1):
        for j in range(1, m + 1):
            M[0, i, j] = D[i - 1, j - 1] + P[i - 1, j - 1]
            for c in range(1, cap):
                M[c, i, j] = M[c - 1, i - 1, j] + P[i - 1, j - 1] - pen[j - 1]
        for j in range(m + 1):
            best, how = D[i - 1, j] + skip, 0
            if j > 0 and D[i, j - 1] > best:
                best, how = D[i, j - 1], 1
            for c in range(cap):
                if M[c, i, j] > best:
                    best, how = M[c, i, j], 2 + c
            D[i, j], back_d[i, j] = best, how
    out, i, j = {}, k, m
    while i > 0:
        how = int(back_d[i, j])  # int8 arithmetic would overflow past 127 numbers (NumPy 2)
        if how == 0:
            i -= 1
        elif how == 1:
            j -= 1
        else:
            c = how - 2  # numbers i-1-c .. i-1 all on building j-1
            for step in range(c + 1):
                out[i - 1 - step] = j - 1
            i, j = i - 1 - c, j - 1
    return D[k, m], out


# Townhouse buildings: a run of 1-3 consecutive numbers, at most two of one
# parity (owner's rule: 26-28-31, 30-32-33; never 26-28-30-32). A number on
# the far side's parity is only allowed as the building's minority.
TOWNHOUSE_MAX_NUMBERS = 3
TOWNHOUSE_JOINT_RATIO = 1.5
TOWNHOUSE_MAX_SAME_PARITY = 2


def _assign_townhouse_street(street, rows, p_both, side_of, positions, home, claimed, share_penalty,
                             directions=(1, -1)):
    """{number: (building, probability)} for one townhouse street, both
    parities together: numbers in increasing order walk the street's home
    buildings (either side) in road order, each building taking a run of
    1-3 numbers, dealt out in equal shares (TOWNHOUSE_SLOT_BONUS)."""
    numbers = sorted(rows["number"].unique())
    ids_by_number = defaultdict(list)
    for address_id, number in zip(rows["id"], rows["number"]):
        ids_by_number[number].append(address_id)
    prob, same = defaultdict(list), {}
    for number, ids in ids_by_number.items():
        for address_id in ids:
            for b, p in p_both.get(address_id, []):
                if (street, b) in positions and (street, b) in home and b not in claimed:
                    prob[(number, b)].append(p)
                    same[(number, b)] = side_of.get((address_id, b), False)
    buildings = sorted({b for _, b in prob})
    if not buildings:
        return {}
    k, m = len(numbers), len(buildings)
    best = None
    for direction in directions:
        order = sorted(buildings, key=lambda b: direction * positions[(street, b)])
        slot = (np.arange(k) * m) // k
        # D[i][j]: best for the first i numbers using the first j buildings.
        D = np.full((k + 1, m + 1), -np.inf)
        D[0, :] = 0.0
        back = {}
        for i in range(1, k + 1):
            for j in range(m + 1):
                cand = [(D[i - 1, j], ("skip_n",))]
                if j > 0:
                    cand.append((D[i, j - 1], ("skip_b",)))
                    b = order[j - 1]
                    for size in range(1, int(TOWNHOUSE_MAX_NUMBERS) + 1):
                        if size > i:
                            break
                        run = numbers[i - size:i]
                        if any((n, b) not in prob for n in run):
                            continue
                        parities = [n % 2 for n in run]
                        if max(parities.count(0), parities.count(1)) > TOWNHOUSE_MAX_SAME_PARITY:
                            continue
                        n_same = sum(same[(n, b)] for n in run)
                        if n_same * 2 <= size:  # far-side numbers must be the minority
                            continue
                        score = sum(np.mean(prob[(n, b)]) + MATCH_BONUS
                                    + TOWNHOUSE_SLOT_BONUS * (slot[numbers.index(n)] == j - 1) for n in run)
                        score -= share_penalty * (size - 1)
                        cand.append((D[i - size, j - 1] + score, ("run", size)))
                value, how = max(cand, key=lambda c: c[0])
                D[i, j], back[(i, j)] = value, how
        out, i, j = {}, k, m
        while i > 0 and (i, j) in back:
            how = back[(i, j)]
            if how[0] == "skip_n":
                i -= 1
            elif how[0] == "skip_b":
                j -= 1
            else:
                b = order[j - 1]
                for n in numbers[i - how[1]:i]:
                    out[n] = (b, float(np.mean(prob[(n, b)])))
                i, j = i - how[1], j - 1
        if best is None or D[k, m] > best[0]:
            best = (D[k, m], out)
    return best[1]


# The range direction is trusted when number and position agree at least
# this well (rank correlation); otherwise both directions are tried.
DIRECTION_MIN_CORR = 0.5


# Each street side's direction straight from TIGER's ranges: on each piece,
# does the side's range grow or shrink along the street line? Votes are
# weighted by piece length; a side is decided when SIDE_DIRECTION_MIN_SHARE
# of its ranged length agrees. Used before _range_directions' guess (which
# mixes both parities: Shady Acres' even side runs 98 -> 2 against its odd
# side's 1 -> 99, so 3 numbers voted the street backwards and 7/21 swapped).
SIDE_DIRECTIONS = True
SIDE_DIRECTION_MIN_SHARE = 0.7
SIDE_DIRECTIONS_SQL = """
SELECT sms.label_street, s.lfromadd, s.ltoadd, s.rfromadd, s.rtoadd,
       ST_LineLocatePoint(l.g, ST_StartPoint(s.geom)), ST_LineLocatePoint(l.g, ST_EndPoint(s.geom)),
       ST_Length(s.geom::geography)
FROM address_inference.street_match_segments sms
JOIN address_inference.streets_ext s ON s.tlid = sms.tlid
JOIN street_lines l ON l.street = sms.label_street
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
"""


def _house_number(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def load_side_directions(dsn, region, town) -> dict:
    """{(street, parity): +1/-1}: +1 = that side's numbers grow along the street line."""
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    votes = defaultdict(lambda: [0.0, 0.0])  # (street, parity) -> [signed, total]
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        for street, lf, lt, rf, rt, a0, a1, length in conn.execute(SIDE_DIRECTIONS_SQL, params).fetchall():
            if a0 is None or a1 is None or a0 == a1:
                continue
            along = 1 if a1 > a0 else -1
            for fr, to in ((lf, lt), (rf, rt)):
                fr, to = _house_number(fr), _house_number(to)
                if fr is None or to is None or fr == to:
                    continue
                v = votes[(street, fr % 2)]
                v[0] += along * (1 if to > fr else -1) * length
                v[1] += length
    return {k: (1 if s > 0 else -1) for k, (s, tot) in votes.items()
            if tot > 0 and abs(s) / tot >= SIDE_DIRECTION_MIN_SHARE}


def _range_directions(addr, scored_df, positions) -> dict:
    """{street: (direction,)} where the ranges clearly say which way the
    numbers run: +1 = numbers grow with position along the street."""
    if "d_m0" not in scored_df.columns:
        return {}
    nearest = scored_df.loc[scored_df.groupby("address_id")["d_m0"].idxmin(), ["address_id", "source_id"]]
    near_of = dict(zip(nearest["address_id"], nearest["source_id"]))
    out = {}
    for street, rows in addr.groupby("street"):
        pairs = [(n, positions.get((street, near_of.get(aid)))) for aid, n in zip(rows["id"], rows["number"])]
        pairs = [(n, p) for n, p in pairs if p is not None]
        if len(pairs) < 3:
            continue
        nums, pos = (pd.Series(v, dtype=float) for v in zip(*pairs))
        if nums.nunique() < 2 or pos.nunique() < 2:
            continue
        corr = nums.rank().corr(pos.rank())
        if abs(corr) >= DIRECTION_MIN_CORR:
            out[street] = (1 if corr > 0 else -1,)
    return out


def probabilities(scored_df) -> pd.Series:
    """Softmax of the ranker's scores within each address."""
    shifted = scored_df["score"] - scored_df.groupby("address_id")["score"].transform("max")
    e = np.exp(shifted)
    return e / e.groupby(scored_df["address_id"]).transform("sum")


# Weight of "the number's place among the side's numbers matches the
# building's place among the side's buildings" next to the ranker's
# probability (see order_constrained_picks).
RANK_WEIGHT = 0.0
MATCH_BONUS = 0.6  # 2026-11-15 with rate_spots on, Freeport: 0.1 2,765 | 0.3 2,831 | 0.6 2,853 | 0.9 2,790 | 1.2 2,782
# A building across the road (not its parity's side) costs this much in road order instead of being ruled out.
# None = ruled out (same_side_only), as before.
CROSS_SIDE_PENALTY = None


def order_constrained_picks(address_df, scored_df, positions, fallback,
                            rank_weight=RANK_WEIGHT, same_side_only=True, street_order=None,
                            claim_min_p=None, other_road_closer_m=None,
                            townhouse_ratio=None, townhouse_share_penalty=None,
                            joint_townhouses=True, property_slot_bonus=None, accessory_max_ratio=None,
                            use_range_direction=True, extra_small_penalty=None, lock_min_points=None,
                            pool_bonus=None, driveway_rules=None, side_directions=None, two_home_places=None) -> dict:
    """{address_id: source_id}. `fallback` (the ranker's own picks) covers
    addresses the ordering step leaves unmatched or can't place.

    same_side_only: a number only takes a building on the side whose TIGER
    range holds its parity (the candidate's same_side feature).
    rank_weight: TIGER ranges often run far past the real numbers (Freeport's
    Arrowhead Ridge Road: range 1-99, real numbers 1-10 over the whole
    road), which drags every interpolation-based probability toward the
    start of the street. Knowing the side's actual numbers, the k-th of n
    numbers should sit about k/n of the way through the side's buildings
    in road order -- this adds that agreement to each pair's score.
    street_order: streets in processing order (street_priority); a building
    an earlier street took is off limits to later ones. None = each street
    on its own, as before."""
    picks = dict(fallback)
    LAST_PLACED.clear()
    LAST_COUNTED.clear()
    driveway_rules = DRIVEWAY_RULES if driveway_rules is None else driveway_rules
    property_bonus = PROPERTY_SLOT_BONUS if property_slot_bonus is None else property_slot_bonus
    townhouse_ratio = TOWNHOUSE_RATIO if townhouse_ratio is None else townhouse_ratio
    townhouse_share_penalty = TOWNHOUSE_SHARE_PENALTY if townhouse_share_penalty is None else townhouse_share_penalty
    scored = scored_df.assign(p=probabilities(scored_df))
    by = ["d_m0", "d_rate_len"] if NO_HOUSE_NEAR_BY == "both" else [NO_HOUSE_NEAR_BY]
    if NO_HOUSE_NEAR_M is not None and set(by) <= set(scored.columns):
        # A number with no building on its side near where its range puts it
        # stays unplaced (review) instead of taking a neighbor's house.
        # "both": TIGER's point AND the road-start spot must agree.
        same = scored[scored["same_side"].astype(bool)].groupby("address_id")
        lonely = None
        for col in by:
            near = same[col].min()
            these = set(near.index[near > NO_HOUSE_NEAR_M])  # NaN (no spot) never counts
            lonely = these if lonely is None else lonely & these
        scored = scored[~scored["address_id"].isin(lonely)]
    limit = OTHER_ROAD_CLOSER_M if other_road_closer_m is None else other_road_closer_m
    if limit is not None and "dist_vs_nearest_road" in scored.columns:
        # Parcel frontage doesn't override this: tried, and corner lots
        # front both roads (173 Flying Point Road's lot has more frontage on
        # Arrowhead Ridge Road) -- it cost 0.3-0.7 points.
        # "Nearer road" means the nearest road the building's own lot touches
        # (dataset.CANDIDATES_SQL), so a private road behind a deep lot
        # doesn't count here.
        far = scored["dist_vs_nearest_road"] >= limit
        # ...unless the building's driveway clearly comes to THIS street
        # (driveways.py: this street is the cheapest road over pavement).
        if driveway_rules and "drive_best" in scored.columns:
            far &= ~(scored["drive_best"] == 1)
        if DRIVEWAY_KEEP_VISIBLE and "drive_off_m" in scored.columns:
            # ...or its driveway visibly reaches THIS street, even if another road is nearer (89 Allen Point
            # Road: 209 m back, Red Fox Run's line 42 m away, a fully paved driveway to Allen Point Road)
            far &= ~(scored["drive_off_m"] <= LANE_MAX_OFF_M).fillna(False)
        if BRANCH_WAY_MAX_M is not None and _BRANCHES:
            # ...or the nearer road is a short way branching off THIS street: houses down such a way often keep
            # the main road's number (89 Allen Point via Red Fox Run, 141 Ash Point via Bibber Way, 75 Long
            # Point via Cascos Way)
            from .street_names import canonical
            street_of = {a: canonical(st) for a, st in zip(address_df["id"], address_df["street"])}
            branch = [_NEAREST_ROAD.get(b) in _BRANCHES.get(street_of.get(a), ())
                      for a, b in zip(scored["address_id"], scored["source_id"])]
            far &= ~np.array(branch, dtype=bool)
        far &= ~drive_reaches(scored, address_df)  # the driveway decides (DRIVE_PRIORITY)
        scored = scored[~far]
    # A building whose driveway clearly goes to another road (that road is
    # at least DRIVEWAY_CLEAR_RATIO times cheaper to reach over pavement)
    # can't take this street's number.
    # Corner buildings (nearest road under DRIVEWAY_SET_BACK_M) sit a short
    # lawn-crossing from both roads, so their path costs are noisier: they
    # need a clearer margin (1 Carriage Road: 5x to Carriage Road).
    if driveway_rules and "drive_ratio" in scored.columns:
        ratio = pd.Series(DRIVEWAY_CLEAR_RATIO, index=scored.index)
        if "dist_road" in scored.columns and "dist_vs_nearest_road" in scored.columns:
            corner = (scored["dist_road"] - scored["dist_vs_nearest_road"]) < DRIVEWAY_SET_BACK_M
            ratio[corner] = DRIVEWAY_CORNER_RATIO
        clear = scored["drive_ratio"] >= ratio
        if DRIVEWAY_MIN_MARGIN and "drive_margin" in scored.columns:
            clear &= scored["drive_margin"] >= DRIVEWAY_MIN_MARGIN
        if DRIVEWAY_KEEP_VISIBLE and "drive_off_m" in scored.columns:
            # owner (89 Allen Point Road): a house with a real, visible driveway to this street is this
            # street's, even when another road happens to be closer (Red Fox Run, 42 m away)
            clear &= ~(scored["drive_off_m"] <= LANE_MAX_OFF_M).fillna(False)
        clear &= ~drive_reaches(scored, address_df)  # the driveway decides (DRIVE_PRIORITY)
        scored = scored[~clear]
    # A pool within POOL_HOME_M marks a home (owner's rule): never a shed,
    # never a "much smaller extra", and a small boost in the assignment.
    home_pool = (scored["pool_m"] <= POOL_HOME_M) if "pool_m" in scored.columns else pd.Series(False, index=scored.index)
    lane = (scored["lane_end"].astype(bool) if "lane_end" in scored.columns else lane_end(scored)) \
        if driveway_rules else pd.Series(False, index=scored.index)
    lane = lane | drive_match(scored, address_df)  # end of a mapped drive from this street: its lane house
    if lane.any():
        scored = scored.assign(p=scored["p"] + LANE_BONUS * lane)
    home_pool = home_pool | lane
    if TREE_COVERED is not None and "canopy_over" in scored.columns:
        home_pool = home_pool | (scored["canopy_over"] >= TREE_COVERED).fillna(False)
    if pool_bonus and home_pool.any():
        scored = scored.assign(p=scored["p"] + pool_bonus * home_pool)
    accessory = ACCESSORY_MAX_RATIO if accessory_max_ratio is None else accessory_max_ratio
    if accessory is not None and "parcel_size_ratio" in scored.columns:
        shed = (scored["parcel_buildings"].fillna(1) >= 2) & (scored["parcel_size_ratio"] < accessory) & ~home_pool
        if ACCESSORY_MIN_M2 is not None and "sqmeters" in scored.columns:
            shed &= ~(scored["sqmeters"] >= ACCESSORY_MIN_M2)
        if ACCESSORY_NEAR_M is not None and _NEAR_BIGGEST:
            # owner's rule: a small building close to a much bigger one is its shed, whatever lot it's on
            near_shed = scored["source_id"].map(lambda b: _NEAR_BIGGEST.get(b, 1.0)) < accessory
            shed |= near_shed & ~home_pool
        scored = scored[~shed]
    if NO_ROOF_SMALL_M2 is not None and "roof_m2" in scored.columns and "sqmeters" in scored.columns:
        open_ground = (scored["canopy_over"].fillna(0) < TREE_COVERED) if "canopy_over" in scored.columns \
            else pd.Series(True, index=scored.index)
        gone = (scored["roof_m2"] == 0) & (scored["sqmeters"] < NO_ROOF_SMALL_M2) & open_ground
        scored = scored[~(gone & ~home_pool.reindex(scored.index))]
    if NO_ROOF and "roof_m2" in scored.columns:
        scored = scored[~((scored["roof_m2"] == 0) & ~home_pool.reindex(scored.index))]
    if SMALL_ROOF_M2 is not None and "roof_m2" in scored.columns:
        scored = scored[~((scored["roof_m2"] < SMALL_ROOF_M2).fillna(False) & ~home_pool.reindex(scored.index))]
    both_sides = scored  # townhouse streets match both parities together
    if same_side_only and CROSS_SIDE_PENALTY is not None:
        # a cost, not a wall: a number may take a building across the road when the evidence is strong
        # (Harpswell: 325 numbers with E911's house on the "other" side, 81% wrong -- swapped TIGER pieces,
        # borrowed ranges, the addresser crossing the road like 120 Allen Point Road)
        scored = scored.assign(p=scored["p"] - CROSS_SIDE_PENALTY * (~scored["same_side"].astype(bool)))
    elif same_side_only:
        scored = scored[scored["same_side"].astype(bool)]
    addr = address_df[address_df["scorable"]].assign(parity=lambda d: d["number"] % 2)
    lock = LOCK_MIN_POINTS if lock_min_points is None else lock_min_points
    locked_buildings = defaultdict(set)  # street -> buildings held by locked complexes
    if lock:
        points = addr.groupby(["street", "number"])["id"].transform("size")
        big = addr[points >= lock]
        for address_id, street in zip(big["id"], big["street"]):
            b = fallback.get(address_id)
            if b is not None:
                locked_buildings[street].add(b)
        addr = addr[points < lock]  # the rest of the street is assigned around them
    number_of = dict(zip(addr["id"], addr["number"]))
    size_of = (dict(zip(scored["source_id"], scored["sqmeters"])) if "sqmeters" in scored.columns else {})

    def big_enough(buildings):
        if TOWNHOUSE_MIN_M2 is None:
            return True
        sizes = [size_of[b] for b in buildings if b in size_of and size_of[b] == size_of[b]]
        return bool(sizes) and float(np.median(sizes)) >= TOWNHOUSE_MIN_M2

    by_address = defaultdict(list)
    for row in scored[["address_id", "source_id", "p"]].itertuples(index=False):
        by_address[row.address_id].append((row.source_id, row.p))
    # Buildings whose nearest road is the address's own street ("home").
    street_of = dict(zip(addr["id"], addr["street"]))
    home = set()
    if "dist_vs_nearest_road" in scored.columns:
        for row in scored.loc[scored["dist_vs_nearest_road"] < 1, ["address_id", "source_id"]].itertuples(index=False):
            home.add((street_of.get(row.address_id), row.source_id))

    # Which way numbers run along each street, from the ranges themselves:
    # each address's interpolated point (M0) sits where the ranges put it,
    # so the buildings nearest those points, in number order, show the
    # direction. Short streets where the ranker is unsure otherwise flipped
    # (Brickyard Cove: 12 at the far end, 44 at the start).
    direction_of = _range_directions(addr, scored_df, positions) if use_range_direction else {}
    extra_penalty = EXTRA_SMALL_PENALTY if extra_small_penalty is None else extra_small_penalty
    pool_bonus = POOL_BONUS if pool_bonus is None else pool_bonus
    pool_homes = (set(scored_df.loc[scored_df["pool_m"] <= POOL_HOME_M, "source_id"])
                  if "pool_m" in scored_df.columns else set())
    if driveway_rules:
        lanes = scored_df["lane_end"].astype(bool) if "lane_end" in scored_df.columns else lane_end(scored_df)
        pool_homes |= set(scored_df.loc[lanes, "source_id"])  # never a "much smaller extra"
    if TREE_COVERED is not None and "canopy_over" in scored_df.columns:
        pool_homes |= set(scored_df.loc[scored_df["canopy_over"] >= TREE_COVERED, "source_id"])
    size_of = dict(zip(scored_df["source_id"], scored_df["sqmeters"].fillna(0))) if "sqmeters" in scored_df.columns else {}
    if EXTRA_SIZE == "lidar" and "roof_m2" in scored_df.columns:
        roof = dict(zip(scored_df["source_id"], scored_df["roof_m2"]))
        size_of = {b: (roof[b] if roof.get(b) == roof.get(b) and roof.get(b) else v) for b, v in size_of.items()}
    lot_of = (dict(zip(scored_df["source_id"], scored_df["parcel_area_m2"]))
              if "parcel_area_m2" in scored_df.columns else {})
    lot_of = {b: v for b, v in lot_of.items() if v == v}  # drop NaN (no parcel)
    groups = dict(tuple(addr.groupby(["street", "parity"])))
    if street_order is not None:
        rank = {st: i for i, st in enumerate(street_order)}
        keys = sorted(groups, key=lambda key: (rank.get(key[0], len(rank)), key))
    else:
        keys = sorted(groups)
    claimed = set()

    # Townhouse streets (either side qualifies, see below) take both
    # parities in one pass: a building can hold 18-19-20 or 26-28-31.
    joint_streets = set()
    if joint_townhouses:
        p_all = defaultdict(set)
        for r in both_sides[["address_id", "source_id"]].itertuples(index=False):
            p_all[r.address_id].add(r.source_id)
        for street, rows in addr.groupby("street"):
            # A side looks like townhouses (as for one-side townhouse mode)...
            side_ok = False
            for _parity, group in rows.groupby("parity"):
                nums = sorted(group["number"].unique())
                blds = {b for aid in group["id"] for b, _ in by_address.get(aid, []) if (street, b) in positions}
                homes = [b for b in blds if (street, b) in home]
                dens = len(nums) / ((nums[-1] - nums[0]) / 2 + 1) if len(nums) > 1 else 0.0
                side_ok |= (bool(homes) and len(nums) >= townhouse_ratio * len(homes) and dens >= TOWNHOUSE_MIN_DENSITY
                            and big_enough(homes))
            # ...AND the whole street has several numbers per home building
            # (Harvest Ridge Road: 15 numbers, 7 buildings), unlike a street
            # of houses numbered 1, 2, 3, 4... across both sides.
            homes_all = {b for aid in rows["id"] for b in p_all.get(aid, ()) if (street, b) in home and (street, b) in positions}
            # Numbers with several address points (units; School Street) are
            # complexes, not townhouse rows: left to the per-side pass.
            repeated = rows["number"].duplicated().any()
            if side_ok and not repeated and homes_all and rows["number"].nunique() >= TOWNHOUSE_JOINT_RATIO * len(homes_all):
                joint_streets.add(street)
        side_of = {(r.address_id, r.source_id): bool(r.same_side)
                   for r in both_sides[["address_id", "source_id", "same_side"]].itertuples(index=False)}
        p_both = defaultdict(list)
        for r in both_sides[["address_id", "source_id", "p"]].itertuples(index=False):
            p_both[r.address_id].append((r.source_id, r.p))
    done_joint = set()

    for street, _parity in keys:
        if street in joint_streets:
            if street in done_joint:
                continue
            done_joint.add(street)
            street_rows = addr[addr["street"] == street]
            assigned = _assign_townhouse_street(street, street_rows, p_both, side_of, positions, home,
                                                claimed, townhouse_share_penalty,
                                                direction_of.get(street, (1, -1)))
            for address_id, number in zip(street_rows["id"], street_rows["number"]):
                if number in assigned:
                    picks[address_id] = assigned[number][0]
            if street_order is not None:
                min_p = CLAIM_MIN_P if claim_min_p is None else claim_min_p
                claimed.update(b for b, p in assigned.values() if p >= min_p)
            continue
        group = groups[(street, _parity)]
        # Shared addresses (units in one complex) are one number: average.
        prob = defaultdict(list)
        for address_id in group["id"]:
            for source_id, p in by_address.get(address_id, []):
                if ((street, source_id) in positions and source_id not in claimed
                        and source_id not in locked_buildings.get(street, ())):
                    prob[(number_of[address_id], source_id)].append(p)
        buildings = sorted({b for _, b in prob})
        if not buildings:
            continue
        numbers = sorted(group["number"].unique())
        k, m = len(numbers), len(buildings)
        number_frac = np.arange(k) / (k - 1) if k > 1 else np.array([0.5])
        building_frac = np.arange(m) / (m - 1) if m > 1 else np.array([0.5])
        rank_fit = 1 - np.abs(number_frac[:, None] - building_frac[None, :])
        home_buildings = [b for b in buildings if (street, b) in home]
        density = k / ((numbers[-1] - numbers[0]) / 2 + 1) if k > 1 else 0.0
        townhouses = (len(home_buildings) > 0 and k >= townhouse_ratio * len(home_buildings)
                      and density >= TOWNHOUSE_MIN_DENSITY and big_enough(home_buildings))
        share = townhouse_share_penalty if townhouses else None
        candidates = home_buildings if townhouses else buildings
        best = None
        tries = ((side_directions[(street, _parity)],) if side_directions and (street, _parity) in side_directions
                 else direction_of.get(street, (1, -1)))
        for direction in tries:
            order = sorted(candidates, key=lambda b: direction * positions[(street, b)])
            P = np.array([[np.mean(prob[(n, b)]) if (n, b) in prob else np.nan for b in order] for n in numbers])
            if townhouses:
                slot = (np.arange(k) * len(order)) // k  # number i's building, dealt out evenly in road order
                P = P + TOWNHOUSE_SLOT_BONUS * (np.arange(len(order))[None, :] == slot[:, None])
            if extra_penalty and not townhouses and k < len(home_buildings):
                lots = [lot_of.get(b) for b in home_buildings if lot_of.get(b) is not None]
                if RURAL_MIN_LOT_M2 is None or (lots and np.median(lots) >= RURAL_MIN_LOT_M2):
                    median_size = np.median([size_of.get(b, 0) for b in home_buildings])
                    smallest = sorted(home_buildings, key=lambda b: (size_of.get(b, 0), b))[: len(home_buildings) - k]
                    extras = {b for b in smallest if size_of.get(b, 0) * EXTRA_SIZE_FACTOR <= median_size
                              and b not in pool_homes}
                    if extras:
                        extra = np.array([b in extras for b in order])
                        P = P - (1e9 if np.isinf(extra_penalty) else extra_penalty) * extra[None, :]
            if not townhouses and property_bonus and 2 <= k < len(home_buildings):
                homes_in_order = [b for b in order if (street, b) in home]
                along = np.array([positions[(street, b)] * direction for b in homes_in_order])
                cuts = sorted(np.argsort(np.diff(along))[::-1][: k - 1] + 1)  # widest gaps
                group_of = {b: int(np.searchsorted(cuts, idx, side="right")) for idx, b in enumerate(homes_in_order)}
                in_slot = np.array([[group_of.get(b, -1) == i for b in order] for i in range(k)])
                P = P + property_bonus * in_slot
            if END_SLOT_BONUS and not townhouses:
                slots = [b for b in order if (street, b) in home] if END_SLOT_HOMES else list(order)
                if len(slots) > k:
                    first = len(slots) - k if END_SLOT_FROM == "max" else 0
                    slot_of = {b: idx - first for idx, b in enumerate(slots)}
                    P = P + END_SLOT_BONUS * np.array([[slot_of.get(b, -1) == i for b in order] for i in range(k)])
            # MATCH_BONUS: placing a number always beats leaving it out, so
            # every number gets a building in road order when the side has
            # enough; a non-candidate pair is never allowed.
            fit = rank_weight * rank_fit if not townhouses else 0.0
            if ISOLATED_BONUS and _ISOLATION and not townhouses:
                alone = np.array([(_ISOLATION.get(b) or 0) >= ISOLATED_M for b in order])
                if alone.any():
                    P = P + ISOLATED_BONUS * alone[None, :]
            P = np.where(np.isnan(P), -1e9, P + fit + MATCH_BONUS)
            if share is None and two_home_places:
                vec = np.array([LOT_SHARE_PENALTY if b in two_home_places else np.inf for b in order])
                total, match = monotone_assign(P, share_penalty=vec if np.isfinite(vec).any() else None)
            else:
                total, match = monotone_assign(P, share_penalty=share)
            if best is None or total > best[0]:
                best = (total, {numbers[i]: order[j] for i, j in match.items()}, direction, order)
        if COUNT_RUNS and not townhouses:
            best = (best[0], count_runs(best[1], numbers, best[3], best[2], street, positions, home, prob),
                    best[2], best[3])
        for address_id, number in zip(group["id"], group["number"]):
            if number in best[1]:
                picks[address_id] = best[1][number]
                LAST_PLACED.add(address_id)
        if ORDERED_FALLBACK and best[1]:
            # Owner: numbers along a side follow the houses' order -- an unplaced number may only fall back to a
            # house strictly between its placed neighbors' houses (227, 215, 233 on High Head is never right).
            direction = best[2]
            at = {n: direction * positions[(street, b)] for n, b in best[1].items()}
            used = set(best[1].values())
            placed = sorted(best[1])
            for address_id, number in zip(group["id"], group["number"]):
                if number in best[1]:
                    continue
                lo = max((at[n] for n in placed if n < number), default=-np.inf)
                hi = min((at[n] for n in placed if n > number), default=np.inf)
                inside = [(np.mean(prob[(number, b)]), b) for b in buildings
                          if (number, b) in prob and b not in used and lo < direction * positions[(street, b)] < hi]
                if inside:
                    picks[address_id] = max(inside)[1]
                elif address_id in picks:
                    del picks[address_id]
        if street_order is not None:
            min_p = CLAIM_MIN_P if claim_min_p is None else claim_min_p
            claimed.update(b for n, b in best[1].items() if np.mean(prob[(n, b)]) >= min_p)
    return picks


# --- properties -------------------------------------------------------------
# A rural property is often a house plus a barn or garage a few meters away
# (Grovers Crossing's 1: 62 and 76 m2 buildings, 10.7 m apart) -- one
# number, not two. Buildings within PROPERTY_GAP_M of each other form one
# property when the group is small; bigger chains are village blocks and
# stay single buildings. Used to score "right property" next to "right
# building" (handing numbers out per property instead of per building was
# tried and didn't help).
PROPERTY_GAP_M = 12
PROPERTY_MAX_BUILDINGS = 3

PROPERTIES_SQL = """
WITH b AS (
    SELECT source_id, geom FROM address_inference.structures
    WHERE state_fips = %(state_fips)s AND source_id = ANY(%(ids)s)
), c AS (
    SELECT source_id, ST_ClusterDBSCAN(ST_Transform(geom, 26919), %(gap)s, 1) OVER () AS cid FROM b
)
SELECT source_id, cid, count(*) OVER (PARTITION BY cid) FROM c
"""


def load_properties(dsn, region, building_ids, gap_m=None) -> dict:
    """{source_id: property id} for buildings in small groups (2..
    PROPERTY_MAX_BUILDINGS within gap_m of each other); others map to
    themselves. Distances in UTM 19N (EPSG:26919), Maine's zone."""
    gap = PROPERTY_GAP_M if gap_m is None else gap_m
    params = {"state_fips": region.state_fips, "ids": list(building_ids), "gap": gap}
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(PROPERTIES_SQL, params).fetchall()
    members = defaultdict(list)
    for source_id, cid, size in rows:
        if 2 <= size <= PROPERTY_MAX_BUILDINGS:
            members[cid].append(source_id)
    out = {}
    for ids in members.values():
        pid = "P:" + min(ids)
        for source_id in ids:
            out[source_id] = pid
    return out


LOT_MAX_BUILDINGS = 3


# Within a lot, which building takes the number after the lane's home:
# None = the one the ranker liked best; "roof" = the biggest roof (outline,
# or the lidar roof when bigger -- 42 Flying Point Road's house is a 78 m2
# outline under trees but a 177 m2 roof); "lidar" = the lidar roof where
# lidar sees one, else the outline; "height" = the tallest roof. Freeport
# (TIGER / E911 roads, today 53.8 / 66.5%): lidar 53.3 / 66.5 (fixes 42,
# ~75 lots swap each way), roof 53.1 / 66.2, height 52.4 / 64.5. "lidar"
# by the owner's call (imagery first). Needs roof_of (load_roofs).
WITHIN_LOT = "lidar"


def load_roofs(dsn) -> dict:
    """{source_id: (roof_m2, roof_h)} from lidar.py's building_lidar; {} if not run."""
    with psycopg.connect(dsn) as conn:
        if conn.execute("SELECT to_regclass('address_inference.building_lidar') IS NULL").fetchone()[0]:
            return {}
        return {sid: (m2, h) for sid, m2, h in
                conn.execute("SELECT source_id, roof_m2, roof_h FROM address_inference.building_lidar")}


# Owner's rule: a lot the tax roll addresses on another street belongs to
# that street (lot 17/13/2/0, "2 DIAMOND DRIVE", beside Curtis Road), so its
# buildings are no place in this street's order. Uses only the tax roll's
# street names, never its numbers. Freeport ML + road order: TIGER 53.3% ->
# 55.8% right building (right lot 61.8% -> 64.6%), E911 roads 66.0% ->
# 67.8% (75.3% -> 77.3%); fixes Webster 50 (TIGER) and Curtis 16 (E911
# roads). 57/59 Lower Mast Landing (TIGER) break: a Mollymauk Lane house had
# been soaking up a number and hiding a miscount at 41/43.
OTHER_STREET_LOTS = True
# Only for lots with at most this many buildings (None = every lot). 89 Allen Point Road, Harpswell: one
# 5-house lot the tax roll calls "10 Merriman Cove Rd" holds 10 and 21 Merriman Cove Road AND 89 Allen Point
# Road (own visible driveway to Allen Point); the rule took 89's house off Allen Point Road.
OTHER_STREET_MAX_BUILDINGS = None
# Imagery first (owner): a building whose traced driveway visibly reaches this street (<= LANE_MAX_OFF_M off
# pavement) is never dropped by OTHER_STREET_LOTS (89 Allen Point Road: 0 m off pavement to Allen Point Rd).
OTHER_STREET_DRIVEWAY_WINS = False


# Owner's rule (location, like the driveway): a building whose tax lot
# touches named roads, none of them this street, can't take this street's
# number -- unless its driveway clearly comes to this street. Which roads a
# lot touches: address_inference.lot_fronts (data/session_2026-11-13_frontage/
# lot_fronts.py; >= 5 m of road within 15 m of the lot), from "tiger" or "osm"
# road lines (OSM internal only). None = off. Harpswell by the Sea's TIGER
# line runs 20-40 m off the real road, so by TIGER 61's lot touches only
# Butler Rd; by OSM it touches both. Harpswell ML + road order right building
# (2026-11-13): off 55.44%, tiger 54.44%, osm 55.15% (55.23% with loose names),
# both 55.39% -- lots on lanes missing from the road data seem to touch only
# the main road, and corner lots touch both. Off.
LOT_FRONTS = None


_FRONTS_CACHE = {}


def load_lot_fronts_cached():
    """lot_fronts (TIGER or OSM) for the town set by set_guard_town."""
    return _FRONTS_CACHE.get("fronts", {})


def set_guard_town(dsn, town):
    _FRONTS_CACHE["fronts"] = load_lot_fronts(dsn, town, "both") if DRIVE_LOT_GUARD in ("fronts", "both") else {}
    _ISOLATION.clear()
    if ISOLATED_BONUS:
        _ISOLATION.update(load_isolation(dsn, town))
    _NEAR_BIGGEST.clear()
    if ACCESSORY_NEAR_M is not None:
        _NEAR_BIGGEST.update(load_near_biggest(dsn, town, ACCESSORY_NEAR_M))
    _NEAR_SMALL.clear()
    if SHED_SMALL_ROOF_M2 is not None:
        _NEAR_SMALL.update(load_near_small(dsn, town))
    _TOUCHING.clear()
    if SHED_TOUCH_M is not None:
        _TOUCHING.update(load_touching(dsn, town))
    _ATTACHED.clear()
    if SHED_ATTACHED_M is not None:
        _ATTACHED.update(load_touching(dsn, town, near=SHED_ATTACHED_M))
    _SOLAR.clear()
    if NOT_SOLAR:
        from .solar import solar_footprints
        with psycopg.connect(dsn) as conn:
            _SOLAR.update(solar_footprints(conn, "ME", "23", town))
    _OCC.clear()
    if LOT_TWO_DWELLINGS:
        with psycopg.connect(dsn) as conn:
            _OCC.update(dict(conn.execute(OCC_SQL, {"town": town}).fetchall()))
    _DRIVE_TO.clear()
    _STREET_NAMES.clear()
    if DRIVE_PRIORITY:
        _DRIVE_TO.update(load_drive_to(dsn, town, DRIVE_END_M))
        from .street_names import canonical
        with psycopg.connect(dsn) as conn:
            for label, fullname in conn.execute(STREET_NAMES_SQL, {"town": town}):
                _STREET_NAMES.setdefault(label, set()).add(canonical(fullname))
    _BRANCHES.clear()
    _NEAREST_ROAD.clear()
    if BRANCH_WAY_MAX_M is not None:
        branches, nearest = load_branches(dsn, town, BRANCH_WAY_MAX_M)
        _BRANCHES.update(branches)
        _NEAREST_ROAD.update(nearest)


# Short ways branching off a street (owner's three cases: 89 Allen Point Road at the end of Red Fox Run, 141
# Ash Point Road down Bibber Way, 75 Long Point Road down Cascos Way): E911 numbered the house on the main
# road. With BRANCH_WAY_MAX_M set, the "OTHER_ROAD_CLOSER_M" filter doesn't drop a building whose nearest road
# is a way no longer than this whose end meets the address's street. None = off.
BRANCH_WAY_MAX_M = None
_BRANCHES: dict = {}      # canonical main street -> {canonical names of short ways branching off it}

# Owner's priority (89 Allen Point Road, said 3-4 times): the driveway decides. A building within
# DRIVE_END_M of one end of a mapped drive/way (OSM, internal only) whose other end meets a road is that road's
# lane house: never dropped from it by the nearer-road / cheaper-path / lot-street rules, and gets LANE_BONUS
# there. 89's house sits 27 m from the end of the OSM way "Red Fox Run", which starts at Allen Point Road.
DRIVE_PRIORITY = False
DRIVE_END_M = 30.0
DRIVE_MAX_SPOT_M = 100.0  # ...and only for numbers whose road-start spot is within this of the house
DRIVE_MIN_BACK_M = 100.0  # ...and only for houses at least this far from the street (89: 209 m)
# Exemptions from the nearer-road / cheaper-path / lot-street rules for ANY house whose mapped driveway reaches the
# street (owner's literal rule, no limits); False = only the limited drive_match houses.
DRIVE_EXEMPT_ANY = False
_STREET_NAMES: dict = {}  # address street label -> canonical names of its TIGER pieces (set_guard_town)
STREET_NAMES_SQL = """
SELECT DISTINCT m.label_street, s.fullname FROM address_inference.street_match_segments m
JOIN address_inference.streets_ext s ON s.tlid = m.tlid WHERE m.town = %(town)s AND s.fullname IS NOT NULL
"""
_DRIVE_TO: dict = {}  # source_id -> {canonical road names its drive starts at}

DRIVE_TO_SQL = """
WITH b AS (
    SELECT s.source_id, s.geom FROM address_inference.structures s
    JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, s.inner_point)
    WHERE s.state_fips = '23'
), ends AS (
    SELECT d.osm_id, d.name, ST_StartPoint(d.geom) AS here, ST_EndPoint(d.geom) AS there FROM address_inference.osm_drives d
    WHERE d.town = %(town)s
    UNION ALL
    SELECT d.osm_id, d.name, ST_EndPoint(d.geom), ST_StartPoint(d.geom) FROM address_inference.osm_drives d
    WHERE d.town = %(town)s
)
SELECT DISTINCT b.source_id, s.fullname
FROM b JOIN ends e ON e.here && ST_Expand(b.geom, 0.0005) AND ST_DWithin(e.here::geography, b.geom::geography, %(near)s)
JOIN streets s ON s.geom && ST_Expand(e.there, 0.0003) AND ST_DWithin(s.geom::geography, e.there::geography, 20)
WHERE s.fullname IS NOT NULL AND upper(s.fullname) != upper(coalesce(e.name, ''))
"""


def load_drive_to(dsn, town, near) -> dict:
    from .street_names import canonical
    out = defaultdict(set)
    with psycopg.connect(dsn) as conn:
        for sid, road in conn.execute(DRIVE_TO_SQL, {"town": town, "near": float(near)}):
            out[sid].add(canonical(road))
    return dict(out)


def drive_reaches(scored, address_df):
    """Boolean Series: this row's building has a mapped driveway reaching this address's street -- never excluded
    from it (owner: "if primary road is connected, who cares about the sub road ... if I'm the owner of house";
    2025 Harpswell Islands Road's driveway crosses Water Cove Road to Harpswell Islands Road)."""
    if not DRIVE_PRIORITY or not _DRIVE_TO:
        return pd.Series(False, index=scored.index)
    if not DRIVE_EXEMPT_ANY:
        return drive_match(scored, address_df)  # the limited version (set back, spot near)
    from .street_names import canonical
    street_of = dict(zip(address_df["id"], address_df["street"]))
    names = lambda st: _STREET_NAMES.get(st, set()) | {canonical(st)}
    return pd.Series([bool(names(street_of.get(a)) & _DRIVE_TO.get(b, set())) if street_of.get(a) else False
                      for a, b in zip(scored["address_id"], scored["source_id"])], index=scored.index)


def drive_match(scored, address_df):
    """Boolean Series: this row's building sits at the end of a mapped drive that starts at this address's street."""
    if not DRIVE_PRIORITY or not _DRIVE_TO:
        return pd.Series(False, index=scored.index)
    from .street_names import canonical
    street_of = dict(zip(address_df["id"], address_df["street"]))
    # every name the address's street goes by: its E911 spelling and its TIGER pieces' names (Harpswell Islands
    # Road is "Harpswell Island Rd" on 134 of its 158 TIGER pieces -- the drive's road never matched)
    names = lambda st: _STREET_NAMES.get(st, set()) | {canonical(st)}
    match = pd.Series([bool(names(street_of.get(a)) & _DRIVE_TO.get(b, set())) if street_of.get(a) else False
                       for a, b in zip(scored["address_id"], scored["source_id"])], index=scored.index)
    if DRIVE_MAX_SPOT_M is not None and "d_rate_len" in scored.columns:
        # only the numbers whose road-start spot is near the house: with the bonus on every number of the street,
        # 72 Allen Point Road (spot ~200 m away) took 89's house
        match &= (scored["d_rate_len"] <= DRIVE_MAX_SPOT_M).fillna(False)
    if "dist_road" in scored.columns:
        # a house set back down its drive (89: 209 m), like any lane house -- houses by the road at the end of a
        # short driveway don't need it, and the bonus only disturbed their sequence
        match &= (scored["dist_road"] >= DRIVE_MIN_BACK_M).fillna(False)
    return match
_NEAREST_ROAD: dict = {}  # source_id -> canonical name of its nearest TIGER road

BRANCHES_SQL = """
WITH roads AS (
    SELECT s.fullname, ST_Union(s.geom) AS g, sum(ST_Length(s.geom::geography)) AS len
    FROM streets s JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s)
     AND s.geom && t.geom AND ST_Intersects(s.geom, t.geom)
    WHERE s.fullname IS NOT NULL GROUP BY s.fullname
), ends AS (
    SELECT fullname, len, (ST_DumpPoints(ST_Boundary(ST_LineMerge(g)))).geom AS pt FROM roads
)
SELECT DISTINCT m.fullname, e.fullname
FROM ends e JOIN roads m ON m.fullname != e.fullname AND m.g && ST_Expand(e.pt, 0.0003)
 AND ST_DWithin(m.g::geography, e.pt::geography, 15)
WHERE e.len <= %(max_len)s
"""
NEAREST_ROAD_SQL = """
SELECT b.source_id, n.fullname
FROM address_inference.structures b
JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, b.inner_point)
CROSS JOIN LATERAL (SELECT s.fullname FROM streets s WHERE s.fullname IS NOT NULL
                    ORDER BY s.geom <-> b.inner_point LIMIT 1) n
WHERE b.state_fips = '23'
"""


def load_branches(dsn, town, max_len) -> tuple[dict, dict]:
    from .street_names import canonical
    branches = defaultdict(set)
    with psycopg.connect(dsn) as conn:
        for main, way in conn.execute(BRANCHES_SQL, {"town": town, "max_len": float(max_len)}):
            branches[canonical(main)].add(canonical(way))
        nearest = {sid: canonical(name) for sid, name in conn.execute(NEAREST_ROAD_SQL, {"town": town})}
    return dict(branches), nearest


# Owner's rule (2026-11-16, 148 Allen Point Road, Harpswell): a shed stands close to its house, and the
# house may be on another tax lot (148's 53 m2 shed is 37 m from its 276 m2 house, on the neighbor's lot;
# road order put 148 on the shed). With ACCESSORY_NEAR_M set, a building whose size is under
# ACCESSORY_MAX_RATIO of the biggest building within ACCESSORY_NEAR_M (any lot) is a shed. None = off.
ACCESSORY_NEAR_M = None
_NEAR_BIGGEST: dict = {}  # source_id -> its size / the biggest building's size within ACCESSORY_NEAR_M

# Only a building FEMA leaves "Unclassified" can be a shed, and only next to a dwelling: a small house next
# to a store or an inn keeps its number (2 Lobster Lane: 72 m2 house beside a 688 m2 store; 2046 Harpswell
# Islands Road: 93 m2 house beside a 1,010 m2 inn).
SHED_CLASSES = ("Unclassified",)
HOME_CLASSES = ("Single Family Dwelling", "Multi - Family Dwelling", "Manufactured Home")
# The shed's own size: its lidar roof when lidar found one (cbae4a26 by 18 Tide Mill Cove Road: a 214 m2 outline,
# a 37 m2 roof -- the outline is a deck or pad), else its outline (148 Allen Point Road's shed: no roof found).
SHED_SIZE_BY_ROOF = False
NEAR_BIGGEST_SQL = """
SELECT s.source_id,
       {shed_size} / nullif(greatest({shed_size}, (
           SELECT max(greatest(o.sqmeters, coalesce(ol.roof_m2, 0)))
           FROM address_inference.structures o
           LEFT JOIN address_inference.building_lidar ol ON ol.state_fips = o.state_fips AND ol.source_id = o.source_id
           WHERE o.state_fips = s.state_fips AND o.source_id != s.source_id AND o.geom && ST_Expand(s.geom, 0.001)
             AND o.prim_occ = ANY(%(homes)s)
             AND ST_DWithin(o.geom::geography, s.geom::geography, %(near)s))), 0)
FROM address_inference.structures s
JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, s.inner_point)
LEFT JOIN address_inference.building_lidar bl ON bl.state_fips = s.state_fips AND bl.source_id = s.source_id
WHERE s.state_fips = '23' AND coalesce(s.prim_occ, 'Unclassified') = ANY(%(sheds)s)
"""


def load_near_biggest(dsn, town, near) -> dict:
    """{source_id: its size / the biggest building's size within `near` m (itself included)}."""
    shed_size = ("CASE WHEN bl.roof_m2 > 0 THEN least(s.sqmeters, bl.roof_m2) ELSE s.sqmeters END"
                 if SHED_SIZE_BY_ROOF else "greatest(s.sqmeters, coalesce(bl.roof_m2, 0))")
    with psycopg.connect(dsn) as conn:
        return {sid: r for sid, r in conn.execute(NEAR_BIGGEST_SQL.replace("{shed_size}", shed_size), {
            "town": town, "near": float(near), "homes": list(HOME_CLASSES), "sheds": list(SHED_CLASSES)})
                if r is not None}


# Outbuildings FEMA calls dwellings (2019/2025 Harpswell Islands Road: 60/66 m2 lidar roofs on their own lots
# across Water Cove Road from 228/147 m2-roof houses). With SHED_SMALL_ROOF_M2 set, a building of any class with a
# lidar roof under that, within SHED_SMALL_NEAR_M of a dwelling with at least 1/SHED_SMALL_RATIO its roof, is that
# house's outbuilding. Harpswell: 72 wrong numbers sit on such a building; None = off.
SHED_SMALL_ROOF_M2 = None
SHED_SMALL_NEAR_M = 60.0
SHED_SMALL_RATIO = 0.5
_NEAR_SMALL: dict = {}
NEAR_SMALL_SQL = """
SELECT s.source_id, bl.roof_m2 / nullif((
           SELECT max(coalesce(nullif(ol.roof_m2, 0), o.sqmeters))
           FROM address_inference.structures o
           LEFT JOIN address_inference.building_lidar ol ON ol.state_fips = o.state_fips AND ol.source_id = o.source_id
           WHERE o.state_fips = s.state_fips AND o.source_id != s.source_id AND o.geom && ST_Expand(s.geom, 0.001)
             AND o.prim_occ = ANY(%(homes)s)
             AND ST_DWithin(o.geom::geography, s.geom::geography, %(near)s)), 0)
FROM address_inference.structures s
JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, s.inner_point)
JOIN address_inference.building_lidar bl ON bl.state_fips = s.state_fips AND bl.source_id = s.source_id
WHERE s.state_fips = '23' AND bl.roof_m2 > 0 AND bl.roof_m2 < %(max_roof)s
"""


# Owner (227 High Head Road, Harpswell): a building almost touching a bigger house is part of it -- a shed, garage
# or ell -- whatever FEMA calls it. cf8e2d36 stands 2 m from 227's 157 m2 house (58 m2 outline, FEMA "dwelling");
# its lidar roof read 312 m2 because lidar merged the two roofs, so outlines, not roofs, are the size here. With
# SHED_TOUCH_M set, a building within SHED_TOUCH_M of a dwelling with at least 1/SHED_TOUCH_RATIO its outline is a
# shed. None = off.
SHED_TOUCH_M = None
SHED_TOUCH_RATIO = 0.5
_TOUCHING: dict = {}
TOUCH_SQL = """
SELECT s.source_id, s.sqmeters / nullif((
           SELECT max(o.sqmeters) FROM address_inference.structures o
           WHERE o.state_fips = s.state_fips AND o.source_id != s.source_id AND o.geom && ST_Expand(s.geom, 0.0003)
             AND o.prim_occ = ANY(%(homes)s)
             AND ST_DWithin(o.geom::geography, s.geom::geography, %(near)s)), 0)
FROM address_inference.structures s
JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = '23'
"""


def load_touching(dsn, town, near=None) -> dict:
    with psycopg.connect(dsn) as conn:
        return {sid: r for sid, r in conn.execute(TOUCH_SQL, {
            "town": town, "near": float(SHED_TOUCH_M if near is None else near),
            "homes": list(HOME_CLASSES)}) if r is not None}


# Owner (2026-11-19, 4 Eider Lane, Topsham: "the building besides it is pretty much as the one building"): a
# building attached to a bigger house -- within SHED_ATTACHED_M of it -- is part of that house, whatever its size.
# 2e7a9dc4 (47 m2) touches 4's 93 m2 house, one 117 m2 lidar roof over both; at 0.505 of it, SHED_TOUCH_RATIO's 0.5
# let it through as its own "house", and 4-22 Eider Lane each slid one house. None = off.
SHED_ATTACHED_M = None
_ATTACHED: dict = {}
# Owner (2026-11-19, 271 Cathance Road, Topsham): footprints that are solar arrays (address_inference/solar.py:
# low lidar roof over a non-roof photo, or a dark square tracker) are never buildings. Needs solar.py run for the
# town (address_inference.footprint_photo); without it nothing is dropped. False = off.
NOT_SOLAR = True  # Topsham 2026-11-19: +1 (271 Cathance), 0 broke; a no-op where solar.py has not run
_SOLAR: set = set()


def load_near_small(dsn, town) -> dict:
    with psycopg.connect(dsn) as conn:
        return {sid: r for sid, r in conn.execute(NEAR_SMALL_SQL, {
            "town": town, "near": SHED_SMALL_NEAR_M, "homes": list(HOME_CLASSES), "max_roof": SHED_SMALL_ROOF_M2})
                if r is not None}


def drop_near_sheds(scored_df):
    """scored_df without sheds standing beside a much bigger house (ACCESSORY_NEAR_M, SHED_SMALL_ROOF_M2), before
    any grouping of buildings into lot places -- 148 Allen Point Road's shed came back in as its lot's building."""
    shed = pd.Series(False, index=scored_df.index)
    if ACCESSORY_NEAR_M is not None and _NEAR_BIGGEST and ACCESSORY_MAX_RATIO is not None:
        shed |= scored_df["source_id"].map(lambda b: _NEAR_BIGGEST.get(b, 1.0)) < ACCESSORY_MAX_RATIO
    if SHED_SMALL_ROOF_M2 is not None and _NEAR_SMALL:
        shed |= scored_df["source_id"].map(lambda b: _NEAR_SMALL.get(b, 1.0)) < SHED_SMALL_RATIO
    if SHED_TOUCH_M is not None and _TOUCHING:
        shed |= scored_df["source_id"].map(lambda b: _TOUCHING.get(b, 1.0)) < SHED_TOUCH_RATIO
    if SHED_ATTACHED_M is not None and _ATTACHED:
        shed |= scored_df["source_id"].map(lambda b: _ATTACHED.get(b, 1.0)) < 1.0
    if NOT_SOLAR and _SOLAR:
        shed |= scored_df["source_id"].isin(_SOLAR)
    return scored_df[~shed]


# Owner's rule (2026-11-15): a building standing alone -- ISOLATED_M or more
# from any other building -- is somebody's address and can't be left without a
# number just because the side has more buildings than numbers. Only clusters
# (a campus core, a farm's barns) may hold unnumbered buildings. 252 Bayview
# Road: its building is 144 m from any other; the campus core buildings 6-31 m
# apart outscored it (0.40-0.54 vs 0.33) and road order dropped it for free.
# Adds ISOLATED_BONUS to every number's score for such a building in road
# order's table (None = off).
ISOLATED_M = 100
ISOLATED_BONUS = None
_ISOLATION: dict = {}

ISOLATION_SQL = """
SELECT a.source_id, n.d
FROM address_inference.structures a
JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, a.inner_point)
CROSS JOIN LATERAL (
    SELECT ST_Distance(a.geom::geography, b.geom::geography) AS d
    FROM address_inference.structures b
    WHERE b.state_fips = a.state_fips AND b.source_id != a.source_id
    ORDER BY a.geom <-> b.geom LIMIT 1) n
WHERE a.state_fips = '23'
"""


def load_isolation(dsn, town) -> dict:
    """{source_id: meters to the nearest other building} for the town's buildings."""
    with psycopg.connect(dsn) as conn:
        return {sid: d for sid, d in conn.execute(ISOLATION_SQL, {"town": town}).fetchall()}


def load_lot_fronts(dsn, town, source) -> dict:
    """{parcel_id: {canonical road, ...}}"""
    out = defaultdict(set)
    with psycopg.connect(dsn) as conn:
        if conn.execute("SELECT to_regclass('address_inference.lot_fronts') IS NULL").fetchone()[0]:
            return {}
        for pid, road in conn.execute(
                "SELECT f.parcel_id, f.road FROM address_inference.lot_fronts f "
                "JOIN address_inference.parcels p USING (parcel_id) WHERE p.town = %s AND "
                "(f.source = %s OR %s = 'both')",
                (town, source, source)).fetchall():
            out[pid].add(road)
    return dict(out)


# A building's lot outranks its traced driveway: where the tax roll names
# this street for the lot ("taxroll", street names only) or the lot touches
# this street (lot_fronts, "fronts"), the driveway rules can't drop the
# building for this street. 18 Basin Point Road: lot touches only Basin Point
# Road, tax roll says 18 Basin Point Rd, but the tracer reached Shea Rd near
# the corner (320 vs 768) -- dropped, so 18 took 26's house and 26 a shed.
# None = off.
# ...and the same lot evidence beats "another road is OTHER_ROAD_CLOSER_M
# nearer" (33 Williams Road: 103 m from Williams Rd, nearer Fairhaven Ln, lot
# "33 WILLIAMS RD"). False = off.
NEAR_ROAD_LOT_GUARD = False  # 2026-11-13 with the fallback rule: Harpswell -10, Gray -37, New Gloucester -9, Freeport -1, Yarmouth +9 -- off
DRIVE_LOT_GUARD = "both"  # Harpswell ML + road order: off 56.14%, taxroll 57.28, fronts 57.28, both 57.38


# Owner's rule for a very short end branch: a dead-end TIGER piece of at most
# END_BRANCH_MAX_M with no range, at the end of the street's line. Count its
# houses (one per tax lot, the biggest; buildings past the fork, within
# END_BRANCH_NEAR_M of the piece) -- k of them -- and give the street's last k
# numbers (whichever end of the numbering the branch is at) to them in order
# along the road, sides ignored. Ash Cove Road: north branch (87 m), houses of
# 64 and 75 (75's lot also has a 66 m2 shed) -- 64/75 had landed on the main
# stretch, whose TIGER range runs to 99. None = off.
END_BRANCH_MAX_M = None  # 2026-11-13: Ash Cove 64/75 right, but Harpswell 2,239 -> 2,233 (8 lost on Cragmoor, Linwood, Sinnett, Windy Hill); off pending owner review
END_BRANCH_NEAR_M = 50
END_BRANCH_MAX_HOUSES = 3
END_BRANCH_SQL = """
WITH pieces AS (
    SELECT sms.label_street AS street, s.tlid, s.geom, l.g,
           ST_StartPoint(s.geom) AS a, ST_EndPoint(s.geom) AS b
    FROM address_inference.street_match_segments sms
    JOIN address_inference.streets_ext s ON s.tlid = sms.tlid
    JOIN street_lines l ON l.street = sms.label_street
    WHERE sms.region_id = %(region)s AND sms.town = %(town)s
      AND coalesce(s.lfromadd, '') = '' AND coalesce(s.rfromadd, '') = ''
      AND coalesce(s.ltoadd, '') = '' AND coalesce(s.rtoadd, '') = ''
      AND ST_Length(s.geom::geography) <= %(max_m)s
), ends AS (
    SELECT p.*, e.dead, e.fork FROM pieces p
    CROSS JOIN LATERAL (VALUES (p.a, p.b), (p.b, p.a)) e(dead, fork)
    WHERE NOT EXISTS (SELECT 1 FROM streets o WHERE o.tlid <> p.tlid AND o.geom && ST_Expand(e.dead, 0.0001)
                        AND ST_DWithin(o.geom::geography, e.dead::geography, 2))
      AND least(ST_Distance(e.dead::geography, ST_StartPoint(p.g)::geography),
                ST_Distance(e.dead::geography, ST_EndPoint(p.g)::geography)) <= 5
)
SELECT street, tlid,
       ST_LineLocatePoint(g, fork) * ST_Length(g::geography),
       ST_LineLocatePoint(g, dead) * ST_Length(g::geography)
FROM ends
"""


def end_branch_picks(dsn, region, town, address_df, positions, picks, parcel_of=None, side_directions=None) -> dict:
    """picks with the owner's short-end-branch rule applied (see END_BRANCH_MAX_M)."""
    if not END_BRANCH_MAX_M:
        return picks
    params = {"region": region.id, "town": town, "state_fips": region.state_fips, "max_m": END_BRANCH_MAX_M}
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        branches = conn.execute(END_BRANCH_SQL, params).fetchall()
        if not branches:
            return picks
        near = defaultdict(set)
        for tlid, sid in conn.execute(
                "SELECT tlid, source_id FROM address_inference.building_segments "
                "WHERE state_fips = %s AND tlid = ANY(%s) AND dist_m <= %s",
                (region.state_fips, [b[1] for b in branches], END_BRANCH_NEAR_M)).fetchall():
            near[tlid].add(sid)
        size_of = dict(conn.execute(
            "SELECT source_id, sqmeters FROM address_inference.structures WHERE source_id = ANY(%s)",
            ([s for v in near.values() for s in v],)).fetchall())
    picks = dict(picks)
    addr = address_df
    for street, tlid, fork_pos, dead_pos in branches:
        if fork_pos is None or dead_pos is None or abs(dead_pos - fork_pos) < 1:
            continue
        toward = 1 if dead_pos > fork_pos else -1
        homes = {}
        for sid in near.get(tlid, ()):
            p = positions.get((street, sid))
            if p is None or (p - fork_pos) * toward <= 5:
                continue  # not past the fork
            lot = (parcel_of or {}).get(sid, sid)
            if lot not in homes or (size_of.get(sid) or 0) > (size_of.get(homes[lot]) or 0):
                homes[lot] = sid
        houses = sorted(homes.values(), key=lambda b: (positions[(street, b)] - fork_pos) * toward)
        k = len(houses)
        rows = addr[addr["street"] == street]
        numbers = sorted(rows["number"].unique())
        if k == 0 or k > END_BRANCH_MAX_HOUSES or k >= len(numbers):
            continue
        # which end of the numbering the branch is at: TIGER's side directions, else the picks' trend
        dirs = [d for (st, _p), d in (side_directions or {}).items() if st == street]
        if dirs:
            grow = 1 if sum(dirs) > 0 else -1
        else:
            pairs = [(n, positions.get((street, picks.get(a)))) for a, n in zip(rows["id"], rows["number"])]
            pairs = [(n, p) for n, p in pairs if p is not None]
            if len(pairs) < 3:
                continue
            corr = pd.Series([n for n, _ in pairs]).corr(pd.Series([p for _, p in pairs]))
            if not corr or np.isnan(corr):
                continue
            grow = 1 if corr > 0 else -1
        chosen = numbers[-k:] if grow == toward else numbers[:k][::-1]
        # chosen in order from the fork outward
        given = dict(zip(chosen, houses))
        for a, n in zip(rows["id"], rows["number"]):
            if n in given:
                picks[a] = given[n]
            elif picks.get(a) in houses:
                picks[a] = None  # its building went to the branch; unplaced rather than doubled
        picks = {a: b for a, b in picks.items() if b is not None}
    return picks


# The ranker's own pick stands in wherever road order leaves a number
# unplaced. FALLBACK_LOT_RULE: that stand-in may not be a building on a lot
# the tax roll addresses on another street (33/43 Williams Road fell back to a
# building on "1597 HARPSWELL NECK RD", 300 m off) -- the next-best allowed
# candidate is used instead. False = off.
FALLBACK_LOT_RULE = False  # 2026-11-13 ML + road order right: Harpswell 2,350 -> 2,299 alone; tax-roll street names are wrong too often on corner lots -- off


def allowed_top_picks(scored_df, address_df, parcel_of, streets_of_lot) -> dict:
    """{address_id: source_id}: the ranker's best candidate whose lot isn't the tax roll's for another street."""
    from .street_names import canonical
    street_of = {a: canonical(st) for a, st in zip(address_df["id"], address_df["street"])}
    lot = scored_df["source_id"].map(parcel_of or {})
    bad = np.array([bool(streets_of_lot.get(l)) and street_of.get(a) not in streets_of_lot[l]
                    for a, l in zip(scored_df["address_id"], lot)], dtype=bool)
    ok = scored_df[~bad]
    best = ok.loc[ok.groupby("address_id")["score"].idxmax()]
    return dict(zip(best["address_id"], best["source_id"]))


# Address ids the last order_constrained_picks call placed itself (the rest
# fell back to the ranker's own pick).
LAST_PLACED = set()

# Owner's rule, two houses on one lot (39/43 Williams Road: lot "39", a house
# 69 m back and one 20 m back): where road order left a number unplaced and the
# number next to it on the same side sits on a lot with two real houses (the
# smaller at least LOT_PAIR_MIN_SIZE of the bigger) holding only that one
# number, the lot takes both -- the house farther back from the street gets the
# smaller number. False = off.
LOT_PAIR_FILL = False  # 2026-11-13 Harpswell 2,239 -> 2,182 and 39/43 Williams unchanged (rule not reaching them) -- off, needs a look
LOT_PAIR_MIN_SIZE = 0.4
LOT_PAIR_DIST_SQL = """
SELECT sms.label_street, bs.source_id, min(bs.dist_m)
FROM address_inference.building_segments bs
JOIN address_inference.street_match_segments sms ON sms.tlid = bs.tlid
WHERE bs.state_fips = %(state_fips)s AND sms.region_id = %(region)s AND sms.town = %(town)s
  AND bs.source_id = ANY(%(ids)s) AND bs.rank <> 99
GROUP BY 1, 2
"""


def lot_pair_fill(dsn, region, town, address_df, picks, placed, parcel_of, size_of) -> dict:
    if not LOT_PAIR_FILL or not parcel_of:
        return picks
    picks = dict(picks)
    rows = address_df[address_df["scorable"]][["id", "street", "number"]]
    lot_buildings = defaultdict(list)
    for sid, lot in parcel_of.items():
        lot_buildings[lot].append(sid)
    todo = []  # (street, unplaced number ids, neighbor number ids, lot, homes)
    for street, srows in rows.groupby("street"):
        for parity in (0, 1):
            side = srows[srows["number"] % 2 == parity]
            numbers = sorted(side["number"].unique())
            ids_of = {n: list(side.loc[side["number"] == n, "id"]) for n in numbers}
            placed_n = {n for n in numbers if any(a in placed for a in ids_of[n])}
            lot_of_n = {n: parcel_of.get(picks.get(ids_of[n][0])) for n in placed_n}
            per_lot = defaultdict(set)
            for n, lot in lot_of_n.items():
                if lot is not None:
                    per_lot[lot].add(n)
            used = set()
            for i, n in enumerate(numbers):
                if n in placed_n:
                    continue
                for j in (i - 1, i + 1):
                    if not 0 <= j < len(numbers):
                        continue
                    nb = numbers[j]
                    lot = lot_of_n.get(nb)
                    if lot is None or lot in used or len(per_lot[lot]) != 1:
                        continue
                    homes = sorted(lot_buildings[lot], key=lambda b: -(size_of.get(b) or 0))[:2]
                    if len(homes) < 2 or (size_of.get(homes[1]) or 0) < LOT_PAIR_MIN_SIZE * (size_of.get(homes[0]) or 1):
                        continue
                    todo.append((street, ids_of[n], n, ids_of[nb], nb, homes))
                    used.add(lot)
                    break
    if not todo:
        return picks
    params = {"region": region.id, "town": town, "state_fips": region.state_fips,
              "ids": [b for *_r, homes in todo for b in homes]}
    with psycopg.connect(dsn) as conn:
        dist = {(st, sid): d for st, sid, d in conn.execute(LOT_PAIR_DIST_SQL, params).fetchall()}
    for street, ids_n, n, ids_nb, nb, homes in todo:
        if any((street, h) not in dist for h in homes):
            continue
        deep, front = sorted(homes, key=lambda h: -dist[(street, h)])
        small, big = (ids_n, ids_nb) if n < nb else (ids_nb, ids_n)
        for a in small:
            picks[a] = deep
        for a in big:
            picks[a] = front
    return picks


# Owner's "several options, keep the best" with a spacing check: after road
# order, each street side also tries every placed number moved one house
# forward and one house back along the road (a house freed at an end goes to an
# unplaced number). Each option is scored by the ranker's probabilities plus
# how evenly the numbers follow distance along the road (Maine numbers by
# distance: Basin Cove 14 at 221 m ... 74/82 at 14 m, ~1 number per 3 m). The
# shifted even side -- 14 left out, 24 on 14's house, ... -- breaks that line.
# SPACING_WEIGHT: points per unit of the fit's R^2 gained. None = off.
SPACING_WEIGHT = 1.0  # on/off (None = off)
SPACING_MIN_NUMBERS = 4
SPACING_MAX_RATIO = 0.75   # an option wins when its spacing error is <= 75% of road order's
SPACING_DEBUG = None
SPACING_MIN_PROB = 0.8     # ...and the ranker's summed probability isn't below 80% of road order's


def _fit_r2(nums, pos):
    if len(nums) < 3 or np.ptp(pos) == 0 or np.ptp(nums) == 0:
        return 0.0
    r = np.corrcoef(nums, pos)[0, 1]
    return float(r * r) if np.isfinite(r) else 0.0


def spacing_options(address_df, scored_df, positions, picks, placed) -> dict:
    """picks with each street side's best of {as is, shifted -1, shifted +1}."""
    if SPACING_WEIGHT is None:
        return picks
    p = probabilities(scored_df)
    prob = dict(zip(zip(scored_df["address_id"], scored_df["source_id"]), p))
    same = scored_df[scored_df["same_side"].astype(bool)]
    picks = dict(picks)
    addr = address_df[address_df["scorable"]]
    for (street, parity), g in addr.assign(parity=addr["number"] % 2).groupby(["street", "parity"]):
        ids_of = {n: list(gg["id"]) for n, gg in g.groupby("number")}
        numbers = sorted(ids_of)
        if len(numbers) < SPACING_MIN_NUMBERS:
            continue
        cand = same[same["address_id"].isin(g["id"])]
        houses = sorted({b for b in cand["source_id"] if (street, b) in positions}, key=lambda b: positions[(street, b)])
        if len(houses) < SPACING_MIN_NUMBERS:
            continue
        index = {b: i for i, b in enumerate(houses)}
        cur = {}
        for n in numbers:
            a0 = ids_of[n][0]
            b = picks.get(a0)
            if a0 in placed and b in index:
                cur[n] = index[b]
        if len(cur) < SPACING_MIN_NUMBERS:
            continue
        def score(assign):
            ns = sorted(assign)
            nums = np.array(ns, dtype=float)
            pos = np.array([positions[(street, houses[assign[n]])] for n in ns], dtype=float)
            if np.ptp(pos) == 0:
                rms = np.inf
            else:
                k, c = np.polyfit(pos, nums, 1)
                rms = float(np.sqrt(np.mean((nums - (k * pos + c)) ** 2)))
            pr = sum(np.mean([prob.get((a, houses[assign[n]]), 0.0) for a in ids_of[n]]) for n in ns)
            return pr, rms, len(ns)
        options = [cur]
        for s in (-1, 1):
            alt = {n: i + s for n, i in cur.items() if 0 <= i + s < len(houses)}
            free = [i for i in range(len(houses)) if i not in set(alt.values())]
            left = [n for n in numbers if n not in alt]
            # an end house freed by the shift goes to the left-out number next to that end
            if left and free:
                order_n = sorted(alt, key=lambda n: alt[n])
                if order_n:
                    lo_i, hi_i = alt[order_n[0]], alt[order_n[-1]]
                    rising = order_n[-1] > order_n[0]
                    for i in free:
                        if i < lo_i:
                            n = max((x for x in left if (x < order_n[0]) == rising), default=None, key=lambda x: -abs(x - order_n[0]) * -1)
                        elif i > hi_i:
                            n = min((x for x in left if (x > order_n[-1]) == rising), default=None, key=lambda x: abs(x - order_n[-1]))
                        else:
                            n = None
                        if n is not None and n in left:
                            alt[n] = i
                            left.remove(n)
            if len(alt) >= SPACING_MIN_NUMBERS:
                options.append(alt)
        scored_opts = [(score(o), o) for o in options]
        if street == SPACING_DEBUG:
            import sys as _s; print('SPACING', street, parity, 'houses', len(houses), [(o and dict(sorted(o.items())), sc) for sc, o in scored_opts], file=_s.stderr)
        (cur_pr, cur_rms, cur_k), _ = scored_opts[0]
        best = None
        for (pr, rms, k), o in scored_opts[1:]:
            if (k >= cur_k and rms <= SPACING_MAX_RATIO * cur_rms and pr >= SPACING_MIN_PROB * cur_pr
                    and (best is None or rms < best[0])):
                best = (rms, o)
        if best is None:
            continue
        best = best[1]
        for n, i in best.items():
            for a in ids_of[n]:
                picks[a] = houses[i]
        for n in numbers:
            if n not in best and n in cur:
                for a in ids_of[n]:
                    picks.pop(a, None)
    return picks


# Owner's "several options, keep the best", one number at a time: a number
# with no house of its own (Bayview Road 220 is the campus entrance, 156 m
# from any building) takes a neighbor's house in road order and every number
# after it slides one house on. On each street side, the DROP_ONE_TRIES
# numbers sitting farthest from the side's number-by-distance line are each
# tried left out, the side re-assigned without it (monotone_assign over the
# ranker's probabilities); the option wins when its spacing error is at most
# DROP_ONE_MAX_RATIO of road order's and the other numbers' summed
# probability isn't below DROP_ONE_MIN_PROB of theirs. The left-out number
# goes to review (never a guessed house). None = off.
DROP_ONE_MAX_RATIO = None
DROP_ONE_MIN_PROB = 0.8
DROP_ONE_TRIES = None  # None = every placed number
DROP_ONE_WINDOW = 8
DROP_ONE_MIN_NUMBERS = 4
DROP_ONE_DEBUG = None
LAST_DROPPED = set()


def _rms_line(nums, pos):
    nums = np.asarray(nums, float); pos = np.asarray(pos, float)
    if len(nums) < 3 or np.ptp(pos) == 0:
        return np.inf
    k, c = np.polyfit(pos, nums, 1)
    return float(np.sqrt(np.mean((nums - (k * pos + c)) ** 2)))


# Owner: "there is nothing wrong with a big gap (long distance)" -- judge
# each number against its neighbors, not one line per side. For consecutive
# placed numbers, the meters per number of the pair against the side's median
# meters per number; a big gap is fine when the numbers jump as much. Cost =
# mean over pairs of |log(ratio)| (mean: leaving a number out drops a pair), each pair capped at NEIGHBOR_CAP; pairs
# closer than NEIGHBOR_MIN_M count as NEIGHBOR_MIN_M apart.
DROP_ONE_COST = "neighbor"  # or "line" (one straight line per side, 2026-11-14: lost)
NEIGHBOR_MIN_M = 5.0
NEIGHBOR_CAP = math.log(10)


def _neighbor_cost(nums, pos, rate=None):
    nums = np.asarray(nums, float); pos = np.asarray(pos, float)
    if len(nums) < 3:
        return np.inf
    o = np.argsort(nums)
    dn = np.diff(nums[o]); dq = np.maximum(np.abs(np.diff(pos[o])), NEIGHBOR_MIN_M)
    per = dq / np.maximum(dn, 1)
    rate = float(np.median(per)) if rate is None else rate
    return float(np.mean(np.minimum(np.abs(np.log(per / rate)), NEIGHBOR_CAP)))


def drop_one_options(address_df, scored_df, positions, picks, placed, fallback) -> dict:
    """picks with, per street side, one number left out when that clearly
    straightens the side's numbering. Left-out ids are in LAST_DROPPED (their
    pick reverts to fallback; callers take them out of the placed set)."""
    LAST_DROPPED.clear()
    if DROP_ONE_MAX_RATIO is None:
        return picks
    p = probabilities(scored_df)
    prob = dict(zip(zip(scored_df["address_id"], scored_df["source_id"]), p))
    same = scored_df[scored_df["same_side"].astype(bool)]
    picks = dict(picks)
    addr = address_df[address_df["scorable"]]
    for (street, parity), g in addr.assign(parity=addr["number"] % 2).groupby(["street", "parity"]):
        ids_of = {n: list(gg["id"]) for n, gg in g.groupby("number")}
        cur = {}
        for n, ids in ids_of.items():
            b = picks.get(ids[0])
            if ids[0] in placed and (street, b) in positions:
                cur[n] = b
        if len(cur) < DROP_ONE_MIN_NUMBERS + 1:
            continue
        cand = same[same["address_id"].isin(g["id"])]
        houses = sorted({b for b in cand["source_id"] if (street, b) in positions} | set(cur.values()),
                        key=lambda b: positions[(street, b)])
        pn = lambda n, b: float(np.mean([prob.get((a, b), np.nan) for a in ids_of[n]]))
        ns = sorted(cur)
        pos = [positions[(street, cur[n])] for n in ns]
        if DROP_ONE_COST == "neighbor":
            o = np.argsort(ns)
            per = np.maximum(np.abs(np.diff(np.asarray(pos)[o])), NEIGHBOR_MIN_M) / np.maximum(np.diff(np.asarray(ns)[o]), 1)
            side_rate = float(np.median(per))
            cost = lambda nn, qq: _neighbor_cost(nn, qq, side_rate)
        else:
            cost = _rms_line
        cur_rms = cost(ns, pos)
        if not np.isfinite(cur_rms) or cur_rms == 0:
            continue
        rising = np.corrcoef(ns, pos)[0, 1] >= 0 if np.ptp(pos) > 0 else True
        if DROP_ONE_COST == "neighbor":
            # each number's own share: its pairs with the numbers either side
            resid = {}
            for i, n in enumerate(ns):
                lo, hi = max(i - 1, 0), min(i + 2, len(ns))
                with_n = cost(ns[lo:hi], pos[lo:hi]) if hi - lo >= 3 else 0.0
                resid[n] = with_n
        else:
            k, c = np.polyfit(pos, ns, 1)
            resid = {n: abs(n - (k * q + c)) for n, q in zip(ns, pos)}
        best = None
        tries = sorted(ns, key=lambda n: -resid[n])
        if DROP_ONE_TRIES is not None:
            tries = tries[:DROP_ONE_TRIES]
        for x in tries:
            rest = [n for n in ns if n != x]
            xi = ns.index(x)
            alt = None
            # re-solve only the numbers on one side of x, up to DROP_ONE_WINDOW of
            # them, over the houses between the fixed neighbors around that window
            for lo, hi in ((max(xi - DROP_ONE_WINDOW, 0), xi), (xi + 1, min(xi + 1 + DROP_ONE_WINDOW, len(ns)))):
                win = ns[lo:hi]
                if not win:
                    continue
                before = ns[lo - 1] if lo - 1 >= 0 and lo - 1 != xi else (ns[xi - 1] if lo == xi + 1 and xi - 1 >= 0 else None)
                after = ns[hi] if hi < len(ns) and hi != xi else (ns[xi + 1] if hi == xi and xi + 1 < len(ns) else None)
                end_lo, end_hi = (-np.inf, np.inf) if rising else (np.inf, -np.inf)
                q1 = positions[(street, cur[before])] if before is not None else end_lo
                q2 = positions[(street, cur[after])] if after is not None else end_hi
                a_q, b_q = min(q1, q2), max(q1, q2)
                used = {cur[n] for n in rest if n not in win}
                pool = [b for b in houses if a_q < positions[(street, b)] < b_q and b not in used]
                order_b = pool if rising else pool[::-1]
                if len(order_b) < len(win):
                    continue
                P = np.array([[pn(n, b) for b in order_b] for n in win])
                P = np.where(np.isnan(P), -1e9, P + MATCH_BONUS)
                _, match = monotone_assign(P, share_penalty=np.inf)
                if len(match) < len(win):
                    continue
                cand_alt = dict(cur); cand_alt.pop(x)
                cand_alt.update({win[i]: order_b[j] for i, j in match.items()})
                c_alt = cost(rest, [positions[(street, cand_alt[n])] for n in rest])
                if alt is None or c_alt < alt[0]:
                    alt = (c_alt, cand_alt)
            if alt is None:
                continue
            alt = alt[1]
            if street == DROP_ONE_DEBUG:
                import sys as _s
                print("TRY", parity, x, "placed", len(alt), "of", len(rest), "moved",
                      sorted(n for n in alt if alt[n] != cur.get(n)), file=_s.stderr)
            if len(alt) < len(rest):
                continue
            # only a run of numbers next to x may move (the chain x started)
            moved = [i for i, n in enumerate(rest) if alt[n] != cur[n]]
            if moved:
                xi = sum(n < x for n in rest)  # x sat between rest[xi-1] and rest[xi]
                if moved != list(range(moved[0], moved[-1] + 1)) or not (moved[0] == xi or moved[-1] == xi - 1):
                    continue
            rms = cost(rest, [positions[(street, alt[n])] for n in rest])
            pr_cur = sum(pn(n, cur[n]) for n in rest if not np.isnan(pn(n, cur[n])))
            pr_alt = sum(pn(n, alt[n]) for n in rest)
            if street == DROP_ONE_DEBUG:
                import sys as _s; print("DROP", street, parity, x, round(cur_rms, 1), round(rms, 1), round(pr_cur, 2), round(pr_alt, 2), file=_s.stderr)
            if rms <= DROP_ONE_MAX_RATIO * cur_rms and pr_alt >= DROP_ONE_MIN_PROB * pr_cur and (best is None or rms < best[0]):
                best = (rms, x, alt)
        if best is None:
            continue
        _, x, alt = best
        for n, b in alt.items():
            for a in ids_of[n]:
                picks[a] = b
        for a in ids_of[x]:
            picks[a] = fallback.get(a, picks.get(a))
            LAST_DROPPED.add(a)
    return picks


# Owner's options strategy, at the scale of a run: on each street side, move
# any run of consecutive numbers one house forward or back along the road
# (into a free house), keeping a move only when it raises
#   sum of the ranker's probabilities - RUN_SHIFT_LAMBDA * spacing error
# (spacing error = RMS of the numbers around a straight line in distance along
# the road). Repeats until no move helps. 734 of Harpswell's 1,819 misses sat on
# the next or previous number's house. None = off.
RUN_SHIFT_LAMBDA = None  # 2026-11-13 Harpswell (spacing on, 2,390): global-fit score 0.05 -> 2,320; spacing-driven with prob cap 0.02/0.05/0.1 -> 2,373/2,369/2,334 -- off
RUN_SHIFT_MAX_ROUNDS = 20
RUN_SHIFT_MIN_RATIO = 0.85  # a move must cut the side's spacing error by 15%+


def run_shift_options(address_df, scored_df, positions, picks, placed) -> dict:
    if RUN_SHIFT_LAMBDA is None:
        return picks
    lam = RUN_SHIFT_LAMBDA
    p = probabilities(scored_df)
    prob = dict(zip(zip(scored_df["address_id"], scored_df["source_id"]), p))
    same = scored_df[scored_df["same_side"].astype(bool)]
    picks = dict(picks)
    addr = address_df[address_df["scorable"]]
    for (street, parity), g in addr.assign(parity=addr["number"] % 2).groupby(["street", "parity"]):
        ids_of = {n: list(gg["id"]) for n, gg in g.groupby("number")}
        if len(ids_of) < 4:
            continue
        cand = same[same["address_id"].isin(g["id"])]
        houses = sorted({b for b in cand["source_id"] if (street, b) in positions}, key=lambda b: positions[(street, b)])
        if len(houses) < 4:
            continue
        index = {b: i for i, b in enumerate(houses)}
        hpos = np.array([positions[(street, b)] for b in houses], dtype=float)
        cur = {}
        for n, ids in ids_of.items():
            b = picks.get(ids[0])
            if ids[0] in placed and b in index:
                cur[n] = index[b]
        if len(cur) < 4:
            continue
        pn = {(n, i): float(np.mean([prob.get((a, houses[i]), 0.0) for a in ids_of[n]]))
              for n in cur for i in range(len(houses))}
        def rms_of(assign):
            ns = np.array(sorted(assign), dtype=float)
            pos = hpos[[assign[int(n)] for n in ns]]
            if np.ptp(pos) == 0:
                return np.inf
            k, c = np.polyfit(pos, ns, 1)
            return float(np.sqrt(np.mean((ns - (k * pos + c)) ** 2)))
        cur_rms = rms_of(cur)
        order_n = sorted(cur, key=lambda n: cur[n])  # numbers in road order
        for _ in range(RUN_SHIFT_MAX_ROUNDS):
            used = set(cur.values())
            improved = None
            m = len(order_n)
            for a in range(m):
                for b in range(a, m):
                    run = order_n[a:b + 1]
                    for s in (-1, 1):
                        edge = cur[run[-1]] + 1 if s == 1 else cur[run[0]] - 1
                        if not 0 <= edge < len(houses) or edge in used:
                            continue
                        alt = dict(cur)
                        for n in run:
                            alt[n] = cur[n] + s
                        drop = sum(pn[(n, cur[n])] - pn[(n, alt[n])] for n in run)
                        if drop > lam * len(run):
                            continue  # the ranker clearly disagrees
                        r = rms_of(alt)
                        if r <= RUN_SHIFT_MIN_RATIO * cur_rms and (improved is None or r < improved[0]):
                            improved = (r, alt)
            if improved is None:
                break
            cur_rms, cur = improved
            order_n = sorted(cur, key=lambda n: cur[n])
        for n, i in cur.items():
            for a_id in ids_of[n]:
                picks[a_id] = houses[i]
    return picks


# Numbers follow distance along the road (Harpswell: on 77% of street sides
# the real houses sit within 5% of the number range of a straight line). Second
# pass: fit each side's line (Theil-Sen, robust) from the numbers road order
# placed itself, then add LINE_BONUS * exp(-(d / sigma)^2) to every candidate's
# probability, d = its distance from where the line puts the number, sigma = the
# side's own scatter in meters (LINE_SIGMA_MIN..MAX); road order runs again.
# It replaces TIGER's often-misplaced ranges with the street's own numbering.
# None = off.
LINE_BONUS = None  # 2026-11-13 Harpswell (2,390): 0.2 2,384 | 0.35 2,386 | 0.5 2,400 | 0.65 2,382 | 0.8 2,358 | 1.0 2,361 -- lone spike, off
LINE_MIN_PLACED = 5
LINE_SIGMA_MIN, LINE_SIGMA_MAX = 15.0, 80.0


def side_lines(address_df, positions, picks, placed) -> dict:
    """{(street, parity): (meters per number, intercept, sigma m)} -- Theil-Sen line of the
    positions of the numbers road order placed itself."""
    expect = {}
    addr = address_df[address_df["id"].isin(placed)]
    for (street, parity), g in addr.assign(parity=addr["number"] % 2).groupby(["street", "parity"]):
        pts = [(n, positions.get((street, picks.get(a)))) for a, n in zip(g["id"], g["number"])]
        pts = sorted({(n, q) for n, q in pts if q is not None})
        if len(pts) < LINE_MIN_PLACED:
            continue
        ns = np.array([n for n, _ in pts], float); qs = np.array([q for _, q in pts], float)
        i, j = np.triu_indices(len(ns), 1)
        dn = ns[j] - ns[i]
        ok = dn != 0
        if not ok.any():
            continue
        slope = float(np.median((qs[j] - qs[i])[ok] / dn[ok]))
        icpt = float(np.median(qs - slope * ns))
        resid = np.abs(qs - (slope * ns + icpt))
        expect[(street, int(parity))] = (slope, icpt, float(np.clip(1.4826 * np.median(resid), LINE_SIGMA_MIN, LINE_SIGMA_MAX)))
    return expect


# Review list: a pick whose house is more than FAR_REVIEW_M (and FAR_REVIEW_SIGMAS
# of the side's scatter) from where its side's numbering line puts the number.
FAR_REVIEW_M = 150
FAR_REVIEW_SIGMAS = 3


def far_from_line(address_df, positions, picks, placed) -> set:
    """address ids whose pick sits far from its side's number-by-distance line."""
    expect = side_lines(address_df, positions, picks, placed)
    out = set()
    for a, st, n in zip(address_df["id"], address_df["street"], address_df["number"]):
        e = expect.get((st, int(n) % 2))
        q = positions.get((st, picks.get(a))) if e else None
        if q is None:
            continue
        slope, icpt, sigma = e
        if abs(q - (slope * n + icpt)) > max(FAR_REVIEW_M, FAR_REVIEW_SIGMAS * sigma):
            out.add(a)
    return out


# Owner (2026-11-16, Bayview Road): "240 is the campus's primary number; 252 was
# added after it, so it's greater and further along." The addresser's spacing
# changes partway along a road (Bayview: ~7.6 m per number overall, 10.3 m for
# 240-252, 5.4 m for 252-270), so the road-wide rate (rate_spots) lands 252 on
# 246's house. Second pass: numbers road order placed on a building within
# ANCHOR_TOL_M of their road-start spot are anchors; every number's spot is
# interpolated between the anchors around it (before the first: toward the
# road's start at number 0; after the last: toward the road's end at the
# street's highest number), and candidates get ANCHOR_BONUS * exp(-(d/sigma)^2).
# The rescored frame carries d_anchor, so NO_HOUSE_NEAR_BY = "d_anchor" leaves a
# number with no building near its anchored spot unplaced (220: the campus
# gate). None = off.
ANCHOR_BONUS = None
ANCHOR_TOL_M = 30.0
ANCHOR_SIGMA_M = 30.0
# "all" numbers, or only the "tail" past each street's last anchor.
# 2026-11-16 Harpswell (saved default 3,415), all: 0.3 3,361 | 0.6 3,288.
ANCHOR_SCOPE = "all"
_SPOTS: dict = {}  # rate_spots.street_spots for the current town (set by evaluate)


def anchored_spots(street, numbers, anchors, spot) -> dict:
    """{number: meters along the street} from anchors [(number, meters)] sorted by number.
    spot = (start_m, direction, rate_len, length_m, k) from rate_spots."""
    start, direction, _rate, length, _k = spot
    end = length if direction > 0 else 0.0
    top = max(numbers)
    xs = [0.0] + [float(n) for n, _ in anchors] + [float(top)]
    ys = [start] + [float(q) for _, q in anchors] + [end]
    # the road's ends only bound the anchors; drop them if an anchor sits on them
    pts = sorted(dict(zip(xs, ys)).items())
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return {n: float(np.interp(n, xs, ys)) for n in numbers}


def anchor_rescore(address_df, scored_df, positions, picks, placed):
    """scored_df with each candidate raised near its anchored spot, plus column d_anchor."""
    if ANCHOR_BONUS is None or not _SPOTS:
        return None
    info = address_df.set_index("id")[["street", "number"]]
    st = scored_df["address_id"].map(info["street"]).to_numpy()
    num = scored_df["address_id"].map(info["number"]).to_numpy()
    rate_town = _SPOTS.get(None)
    spot_of = {}
    for street, g in address_df.groupby("street"):
        s = _SPOTS.get(street)
        if s is None:
            continue
        start, direction, rate_len, _length, _k = s
        anchors = {}
        for a, n in zip(g["id"], g["number"]):
            if a not in placed:
                continue
            q = positions.get((street, picks.get(a)))
            if q is not None and abs(q - (start + direction * n * rate_len)) <= ANCHOR_TOL_M:
                anchors.setdefault(int(n), q)
        # keep anchors that run the street's way (drop any out of order)
        kept = []
        for n, q in sorted(anchors.items()):
            if not kept or (q - kept[-1][1]) * direction > 0:
                kept.append((n, q))
        numbers = sorted({int(n) for n in g["number"]})
        if ANCHOR_SCOPE == "tail":
            # only the road's tail past its last confident number (Bayview's
            # campus end): elsewhere the ranker's own rate features already know
            if not kept:
                continue
            last = kept[-1][0]
            numbers = [n for n in numbers if n > last]
        if not numbers:
            continue
        for n, q in anchored_spots(street, numbers, kept, s).items():
            spot_of[(street, n)] = q
    d_anchor = np.full(len(scored_df), np.nan)
    for k, (a_st, n, b) in enumerate(zip(st, num, scored_df["source_id"])):
        q = positions.get((a_st, b))
        sp = spot_of.get((a_st, int(n))) if isinstance(a_st, str) else None
        if q is not None and sp is not None:
            d_anchor[k] = abs(q - sp)
    p = probabilities(scored_df).to_numpy()
    bonus = np.where(np.isnan(d_anchor), 0.0, ANCHOR_BONUS * np.exp(-(np.nan_to_num(d_anchor) / ANCHOR_SIGMA_M) ** 2))
    out = scored_df.copy()
    out["score"] = np.log(np.clip(p + bonus, 1e-12, None))
    out["d_anchor"] = d_anchor
    return out


def line_rescore(address_df, scored_df, positions, picks, placed):
    """scored_df with each candidate's score raised near its number's line spot."""
    if LINE_BONUS is None:
        return None
    p = probabilities(scored_df).to_numpy()
    info = address_df.set_index("id")[["street", "number"]]
    st = scored_df["address_id"].map(info["street"]).to_numpy()
    num = scored_df["address_id"].map(info["number"]).to_numpy()
    expect = side_lines(address_df, positions, picks, placed)
    addr = address_df.iloc[0:0]
    for (street, parity), g in addr.assign(parity=addr["number"] % 2).groupby(["street", "parity"]):
        pts = [(n, positions.get((street, picks.get(a)))) for a, n in zip(g["id"], g["number"])]
        pts = sorted({(n, q) for n, q in pts if q is not None})
        if len(pts) < LINE_MIN_PLACED:
            continue
        ns = np.array([n for n, _ in pts], float); qs = np.array([q for _, q in pts], float)
        i, j = np.triu_indices(len(ns), 1)
        dn = ns[j] - ns[i]
        ok = dn != 0
        if not ok.any():
            continue
        slope = float(np.median((qs[j] - qs[i])[ok] / dn[ok]))
        icpt = float(np.median(qs - slope * ns))
        resid = np.abs(qs - (slope * ns + icpt))
        sigma = float(np.clip(1.4826 * np.median(resid), LINE_SIGMA_MIN, LINE_SIGMA_MAX))
        expect[(street, int(parity))] = (slope, icpt, sigma)
    bonus = np.zeros(len(scored_df))
    for k, (a_st, n, b) in enumerate(zip(st, num, scored_df["source_id"])):
        e = expect.get((a_st, int(n) % 2)) if isinstance(a_st, str) else None
        q = positions.get((a_st, b)) if e else None
        if q is None:
            continue
        slope, icpt, sigma = e
        d = q - (slope * n + icpt)
        bonus[k] = LINE_BONUS * np.exp(-(d / sigma) ** 2)
    out = scored_df.copy()
    out["score"] = np.log(np.clip(p + bonus, 1e-12, None))
    return out


def lot_streets(lot_addresses) -> dict:
    """{parcel_id: {canonical street, ...}} from load_lot_addresses."""
    out = defaultdict(set)
    for (_, street), lots in lot_addresses.items():
        for lot in lots:
            out[lot].add(street)
    return dict(out)


# Owner's two-houses rule, inside road order: a tax lot whose second-biggest
# building is at least LOT_TWO_HOMES_RATIO of its biggest (and at least
# LOT_TWO_HOMES_MIN_M2) is two places, not one. None = off.
LOT_TWO_HOMES_RATIO = None  # 2026-11-13 Harpswell right: off 2,372 | 0.6 2,354 | 0.8 2,365 (evaluate headline count) -- off; must apply only where a side is short of places
LOT_TWO_HOMES_MIN_M2 = 60
# The same, but only for two buildings FEMA classes as dwellings (HOME_CLASSES), each >= LOT_TWO_DWELLINGS_MIN_M2,
# the smaller >= LOT_TWO_DWELLINGS_RATIO of the bigger -- a barn or garage never splits a lot.
LOT_TWO_DWELLINGS = False
LOT_TWO_DWELLINGS_MIN_M2 = 100
LOT_TWO_DWELLINGS_RATIO = 0.4
_OCC: dict = {}  # source_id -> FEMA prim_occ for the current town (set_guard_town)
OCC_SQL = """
SELECT s.source_id, s.prim_occ FROM address_inference.structures s
JOIN towns t ON t.state_abbr = 'ME' AND upper(t.name) = upper(%(town)s) AND ST_Intersects(t.geom, s.inner_point)
WHERE s.state_fips = '23'
"""


# Owner's two-houses rule, targeted: a lot place whose second house is at
# least LOT_SHARE_MIN_RATIO of its biggest (and LOT_SHARE_MIN_M2) may take a
# second number at LOT_SHARE_PENALTY -- road order only does that when the
# number would otherwise be left out (39/43 Williams Road: odd side 33/39/43,
# two places). spread_within_lots then gives the two numbers to the two houses
# in order along the street. None = off.
LOT_SHARE_PENALTY = None  # off: 0.6 is only +2 and leaves Williams 39/43 wrong; 0.2 would fix them but costs 28 elsewhere. Was: Harpswell right (headline count): off 2,372 | 0.1 2,340 | 0.2 2,344 | 0.4 2,357 | 0.6 2,374
LOT_SHARE_MIN_RATIO = 0.6
LOT_SHARE_MIN_M2 = 60


# Owner's count rule (see lot_picks): a lot's "houses" are its buildings of
# at least COUNT_MATCH_MIN_SHARE of its biggest and COUNT_MATCH_MIN_M2. False = off.
COUNT_MATCH_LOTS = True
LAST_EXPANDED = set()  # (street, parity, lot place) the last lot_picks call split
COUNT_MATCH_MIN_SHARE = 0.4
COUNT_MATCH_MIN_M2 = 40


def lot_picks(address_df, scored_df, positions, fallback, parcel_of, lot_reserve_p=None, roof_of=None,
              streets_of_lot=None, fronts_of_lot=None, **kwargs) -> dict:
    """order_constrained_picks with each multi-building TAX LOT as one place
    along the road (owner's matrix rule: lots are numbered in order, not
    buildings). Lot 42 Brickyard Cove has two houses, one in front of 22's
    house along the road and one past it; as separate places, 22 took the
    front one and every later number shifted. A lot's position is the
    mean of its buildings'; its probability for an address the sum of
    theirs; the building finally picked is the one the ranker liked best.
    parcel_of: {source_id: parcel id}; buildings without one stay single."""
    scored_df = drop_near_sheds(scored_df)
    df = scored_df.assign(p=probabilities(scored_df))
    if OTHER_STREET_LOTS and streets_of_lot:
        from .street_names import canonical
        street_of = {a: canonical(st) for a, st in zip(address_df["id"], address_df["street"])}
        lot_of = df["source_id"].map(parcel_of)
        if OTHER_STREET_MAX_BUILDINGS is not None:
            # a big lot can front several streets (89 Allen Point Road's lot holds 5 houses, the tax roll
            # calls it "10 Merriman Cove Rd"): its one tax-roll street says nothing about each house
            per_lot = Counter(parcel_of.values())
            lot_of = lot_of.where(lot_of.map(lambda l: per_lot.get(l, 0) <= OTHER_STREET_MAX_BUILDINGS))
        other = np.array([bool(streets_of_lot.get(lot)) and street_of.get(a) not in streets_of_lot[lot]
                          for a, lot in zip(df["address_id"], lot_of)], dtype=bool)
        if OTHER_STREET_DRIVEWAY_WINS and "drive_off_m" in df.columns:
            # imagery first (owner): a house whose driveway visibly reaches this street stays this street's,
            # whatever street the tax roll gives its lot (89 Allen Point Road)
            other &= ~(df["drive_off_m"] <= LANE_MAX_OFF_M).fillna(False).to_numpy()
        other &= ~drive_reaches(df, address_df).to_numpy()  # the driveway decides (DRIVE_PRIORITY)
        df = df[~other]
    if DRIVE_LOT_GUARD and "drive_ratio" in df.columns:
        from .street_names import canonical
        street_of = {a: canonical(st) for a, st in zip(address_df["id"], address_df["street"])}
        lot_of = df["source_id"].map(parcel_of)
        guard_fronts = load_lot_fronts_cached() if DRIVE_LOT_GUARD in ("fronts", "both") else {}
        ok = []
        for a, lot in zip(df["address_id"], lot_of):
            st = street_of.get(a)
            g = False
            if DRIVE_LOT_GUARD in ("taxroll", "both") and streets_of_lot:
                g |= st in streets_of_lot.get(lot, ())
            if DRIVE_LOT_GUARD in ("fronts", "both"):
                g |= st in guard_fronts.get(lot, ())
            ok.append(g)
        ok = np.array(ok, dtype=bool)
        df.loc[ok, "drive_ratio"] = np.nan
        if NEAR_ROAD_LOT_GUARD and "dist_vs_nearest_road" in df.columns:
            df.loc[ok, "dist_vs_nearest_road"] = 0.0
        if "drive_margin" in df.columns:
            df.loc[ok, "drive_margin"] = np.nan
    if fronts_of_lot:
        from .street_names import canonical
        street_of = {a: canonical(st) for a, st in zip(address_df["id"], address_df["street"])}
        fronts = df["source_id"].map(parcel_of).map(fronts_of_lot)
        from difflib import SequenceMatcher

        def touches(street, roads):  # loose: "HIGH HEAD" = "HIGH HEAD RD", "GUSS GULLEY" = "GUSS GULLY"
            return street in roads or any(
                r.startswith(street) or street.startswith(r) or SequenceMatcher(None, street, r).ratio() >= 0.85
                for r in roads)
        elsewhere = np.array([isinstance(f, set) and bool(f) and not touches(street_of.get(a, ""), f)
                              for a, f in zip(df["address_id"], fronts)], dtype=bool)
        if "drive_best" in df.columns:
            elsewhere &= ~(df["drive_best"] == 1).to_numpy()
        df = df[~elsewhere]
    lot_size = defaultdict(int)
    for pid in parcel_of.values():
        lot_size[pid] += 1
    # Ordinary lots only: a condo or apartment parcel (Harvest Ridge Road's
    # townhouses, 2 Village View) holds many numbered buildings.
    key = {b: ("lot:" + pid if 1 < lot_size[pid] <= LOT_MAX_BUILDINGS else b) for b, pid in parcel_of.items()}
    if LOT_TWO_HOMES_RATIO and "sqmeters" in df.columns:
        # Owner: a lot with two real houses can hold two numbers (39/43 Williams
        # Road: lot "39", houses of 113 and 127 m2) -- such a lot stays two places.
        size = df.drop_duplicates("source_id").set_index("source_id")["sqmeters"].to_dict()
        by_lot = defaultdict(list)
        for b, pid in parcel_of.items():
            if b in size:
                by_lot[pid].append(size[b] or 0)
        two = {pid for pid, s in by_lot.items()
               if len(s) >= 2 and sorted(s)[-2] >= LOT_TWO_HOMES_RATIO * max(s) and sorted(s)[-2] >= LOT_TWO_HOMES_MIN_M2}
        key = {b: (b if parcel_of.get(b) in two else k) for b, k in key.items()}
    if LOT_TWO_DWELLINGS and _OCC and "sqmeters" in df.columns:
        # Two houses on one lot, told from a house + barn by FEMA's class (33/35 Laurel Point Circle: 125 and
        # 248 m2 "Single Family Dwelling" on one lot -> one place took 33, and 33-61 slid one house).
        size = df.drop_duplicates("source_id").set_index("source_id")["sqmeters"].to_dict()
        homes = defaultdict(list)
        for b, pid in parcel_of.items():
            if _OCC.get(b) in HOME_CLASSES and (size.get(b) or 0) >= LOT_TWO_DWELLINGS_MIN_M2:
                homes[pid].append(size[b])
        two = {pid for pid, s in homes.items()
               if len(s) >= 2 and sorted(s)[-2] >= LOT_TWO_DWELLINGS_RATIO * max(s)}
        key = {b: (b if parcel_of.get(b) in two else k) for b, k in key.items()}
    df["place"] = df["source_id"].map(lambda b: key.get(b, b))
    expanded = set()  # (street, building) placed on its own by COUNT_MATCH_LOTS
    LAST_EXPANDED.clear()
    if COUNT_MATCH_LOTS and "sqmeters" in df.columns and "same_side" in df.columns:
        # Owner's count rule: on a street side with more numbers than places, where
        # counting each two-house lot's houses separately makes houses == numbers
        # exactly, those lots are separate houses on that side (39/43 Williams Road:
        # odd side 33/39/43 = 33's house + one lot with two houses).
        size = df.drop_duplicates("source_id").set_index("source_id")["sqmeters"].fillna(0).to_dict()
        members = defaultdict(list)
        for b, pid in parcel_of.items():
            if b in size:
                members["lot:" + pid].append(b)
        def houses(place):
            if not str(place).startswith("lot:"):
                return [place]
            bs = members.get(place, [])
            big = max((size[b] for b in bs), default=0)
            return [b for b in bs if size[b] >= max(COUNT_MATCH_MIN_SHARE * big, COUNT_MATCH_MIN_M2)]
        info = address_df.set_index("id")[["street", "number"]].rename(columns={"street": "_st", "number": "_num"})
        side = df[df["same_side"].astype(bool)].join(info, on="address_id").rename(columns={"_st": "street_", "_num": "number"})
        side = side.assign(parity=side["number"] % 2)
        for (street, parity), g in side.groupby(["street_", "parity"]):
            k = g["number"].nunique()
            places = set(g["place"])
            if k <= len(places):
                continue
            total = sum(len(houses(p)) for p in places)
            if total != k:
                continue
            ids = set(g["address_id"])
            for p in places:
                hs = houses(p)
                if str(p).startswith("lot:") and len(hs) >= 2:
                    rows_ = df["address_id"].isin(ids) & df["source_id"].isin(hs)
                    df.loc[rows_, "place"] = df.loc[rows_, "source_id"]
                    expanded.update((street, b) for b in hs)
                    LAST_EXPANDED.add((street, int(parity), p))
    # The lane's end is the lot's numbered building, whatever the ranker liked.
    # One lane, one home: of several buildings at the end of a lot's lane
    # (47 Flying Point Road: house, barn and sheds), only the biggest is the
    # home -- each counted as one drew 45 onto 47's barn, and 39-45 shifted.
    lane = lane_end(df)
    if lane.any() and "sqmeters" in df.columns:
        lot = df["source_id"].map(parcel_of)
        cand = df[lane & lot.notna()].assign(_lot=lot)
        home = (cand.sort_values(["sqmeters", "source_id"], ascending=[False, True], kind="stable")
                .drop_duplicates("_lot").set_index("_lot")["source_id"])
        lane &= lot.isna() | (df["source_id"] == lot.map(home))
    df["lane_end"] = lane
    if roof_of:
        # measured with no roof -> 0; never measured -> NaN
        df["roof_m2"] = df["source_id"].map(
            lambda b: np.nan if b not in roof_of else float(roof_of[b][0] or 0)).astype(float)
    order_by = ["address_id", "place", "lane_end", "p"]
    if WITHIN_LOT is not None and roof_of:
        roof = df["source_id"].map(lambda b: (roof_of.get(b) or (None, None)))
        if WITHIN_LOT == "lidar":
            seen = roof.map(lambda r: r[0] if r[0] else np.nan).to_numpy(dtype=float)
            df["_within"] = np.where(np.isnan(seen), df["sqmeters"].fillna(0).to_numpy(), seen)
        elif WITHIN_LOT == "roof":
            df["_within"] = np.fmax(df["sqmeters"].fillna(0).to_numpy(),
                                    roof.map(lambda r: r[0] if r[0] is not None else np.nan).to_numpy(dtype=float))
        else:
            df["_within"] = roof.map(lambda r: r[1] if r[1] is not None else 0.0).astype(float)
        order_by.insert(3, "_within")
    # Only the named building changes; everything the lot is scored and
    # placed by (side, distances...) stays as the ranker's order gives it.
    within_best = None
    if "_within" in df.columns:
        within_best = (df.sort_values(order_by, ascending=[True, True, False, False, False], kind="stable")
                       .drop_duplicates(["address_id", "place"])
                       .set_index(["address_id", "place"])["source_id"])
    df = df.sort_values(["address_id", "place", "lane_end", "p"], ascending=[True, True, False, False], kind="stable")
    agg_spec = {"p_sum": ("p", "sum"), "best": ("source_id", "first"), "same_side": ("same_side", "first")}
    for col, how in (("dist_vs_nearest_road", "min"), ("d_m0", "min"), ("d_rate_len", "min"), ("d_anchor", "min"), ("sqmeters", "max"),
                     ("parcel_size_ratio", "max"), ("parcel_buildings", "min"), ("parcel_area_m2", "max"),
                     ("pool_m", "min"), ("drive_ratio", "min"), ("drive_margin", "min"), ("drive_best", "max"), ("drive_off_m", "min"), ("dist_road", "min"),
                     ("lane_end", "max"), ("canopy_over", "max"), ("roof_m2", "max")):
        if col in df.columns:
            agg_spec[col] = (col, how)
    agg = df.groupby(["address_id", "place"], sort=False).agg(**agg_spec).reset_index()
    reserve = LOT_RESERVE_P if lot_reserve_p is None else lot_reserve_p
    if reserve is not None:
        # A lot belongs to the street whose address wants it most, whatever
        # order the streets are assigned in: 48 Flying Point Road (a main
        # road, assigned first) took the garage beside 2 Johns Road's house.
        street_of = dict(zip(address_df["id"], address_df["street"]))
        agg["_street"] = agg["address_id"].map(street_of)
        by_street = agg.groupby(["place", "_street"])["p_sum"].max()
        top = defaultdict(list)
        for (pl, st), pmax in by_street.items():
            top[pl].append((pmax, st))
        def other_claim(pl, st):
            return max((pm for pm, s2 in top[pl] if s2 != st), default=0.0)
        rival = np.array([other_claim(pl, st) for pl, st in zip(agg["place"], agg["_street"])])
        drop = (rival >= reserve) & (rival > agg["p_sum"].to_numpy())
        # Only a real dispute: a number that never wanted the lot (Baker
        # Road vs a Wardtown Road lot, p ~0) keeps it as a slot -- taking it
        # away shifted whole streets of easy houses.
        drop &= agg["p_sum"].to_numpy() >= LOT_RESERVE_MIN_P
        # Never against the driveway: 40 Baker Road's building was handed to
        # Cedar Lane though its driveway goes to Baker Road.
        if "drive_best" in agg.columns:
            drop &= ~(agg["drive_best"] == 1).to_numpy()
        agg = agg[~drop].drop(columns="_street")
    best_building = {(a, pl): b for a, pl, b in zip(agg["address_id"], agg["place"], agg["best"])}
    if within_best is not None:
        best_building.update({k: within_best[k] for k in best_building if k in within_best.index})
    scored_place = agg.rename(columns={"place": "source_id"}).assign(score=lambda d: np.log(d["p_sum"].clip(lower=1e-12)))
    lists = defaultdict(list)
    for (street, b), along in positions.items():
        lists[(street, key.get(b, b))].append(along)
    positions_place = {k: float(np.mean(v)) for k, v in lists.items()}
    for street, b in expanded:
        if (street, b) in positions:
            positions_place[(street, b)] = positions[(street, b)]
    if LOT_SHARE_PENALTY is not None and "sqmeters" in df.columns:
        size = df.drop_duplicates("source_id").set_index("source_id")["sqmeters"].to_dict()
        by_lot = defaultdict(list)
        for b, pid in parcel_of.items():
            if b in size:
                by_lot[pid].append(size[b] or 0)
        kwargs["two_home_places"] = {"lot:" + pid for pid, s in by_lot.items()
                                     if len(s) >= 2 and sorted(s)[-2] >= LOT_SHARE_MIN_RATIO * max(s)
                                     and sorted(s)[-2] >= LOT_SHARE_MIN_M2}
    picked = order_constrained_picks(address_df, scored_place, positions_place, fallback, **kwargs)
    picks = {a: best_building.get((a, v), v) for a, v in picked.items()}
    if SPREAD_WITHIN_LOT and roof_of is not None:
        size_of = df.drop_duplicates("source_id").set_index("source_id")["_within" if "_within" in df.columns
                                                                          else "sqmeters"].to_dict()
        picks = spread_within_lots(picks, address_df, parcel_of, size_of, positions)
    return picks


# A lot E911 gives several numbers on one street (57 and 59 Lower Mast
# Landing Road: two houses on lot 20/82/D, which the tax roll lists only as
# 59) gets them on that many of its houses, in order along the street -- the
# biggest-roof rule above put both on 57's house.
SPREAD_WITHIN_LOT = True


def street_directions(picks, address_df, positions) -> dict:
    """{street: True if numbers rise along the street line}, from where the
    picks sit (each street number once)."""
    pts = defaultdict(dict)
    for a in address_df.itertuples():
        b = picks.get(a.id)
        if b is not None and (a.street, b) in positions:
            pts[a.street].setdefault(int(a.number), positions[(a.street, b)])
    out = {}
    for street, by_number in pts.items():
        seq = [by_number[n] for n in sorted(by_number)]
        out[street] = sum(b - a for a, b in zip(seq, seq[1:])) >= 0
    return out


def spread_within_lots(picks, address_df, parcel_of, size_of, positions):
    """Several numbers of one street on one ordinary tax lot -> its biggest
    houses (sheds -- under ACCESSORY_MAX_RATIO of the biggest -- never), one
    number each, lowest number first along the street's numbering direction.
    A lot with fewer houses than numbers is left as it is."""
    lot_size = Counter(parcel_of.values())
    on_lot = defaultdict(list)
    for b, lot in parcel_of.items():
        if 1 < lot_size[lot] <= LOT_MAX_BUILDINGS and b in size_of:
            on_lot[lot].append(b)
    rising = street_directions(picks, address_df, positions)
    groups = defaultdict(lambda: defaultdict(list))
    for a in address_df.itertuples():
        b = picks.get(a.id)
        lot = parcel_of.get(b) if b is not None else None
        if lot in on_lot:
            groups[(a.street, lot)][int(a.number)].append(a.id)
    out = dict(picks)
    for (street, lot), by_number in groups.items():
        if len(by_number) < 2:
            continue
        biggest = max(size_of[b] or 0 for b in on_lot[lot])
        houses = sorted((b for b in on_lot[lot] if (size_of[b] or 0) >= ACCESSORY_MAX_RATIO * biggest
                         and (street, b) in positions), key=lambda b: (-(size_of[b] or 0), b))[:len(by_number)]
        if len(houses) < len(by_number):
            continue
        houses.sort(key=lambda b: positions[(street, b)], reverse=not rising.get(street, True))
        for n, house in zip(sorted(by_number), houses):
            for a in by_number[n]:
                out[a] = house
    return out


# The assessor's own address for each tax lot (parcels.prop_loc, e.g. "21
# CARRIAGE ROAD"; DATA_SOURCES.md §5). Kept out of the model -- it nearly
# answers the question (Freeport: 79% of E911 points sit on a lot with the
# same number and street) -- and scored as its own mode instead: where no
# E911 exists, the town's tax roll may be what gives each lot its number.
LOT_ADDRESSES_OLD_SQL = """
SELECT parcel_id, prop_loc FROM address_inference.parcels
WHERE state_fips = %(state_fips)s AND town = %(town)s AND prop_loc IS NOT NULL
ORDER BY parcel_id
"""
LOT_ADDRESSES_SQL = """
-- Harpswell, Pownal: the number sits only in prop_num, prop_loc is the bare street
SELECT parcel_id, CASE WHEN prop_loc !~ '^ *[0-9]' AND prop_num IS NOT NULL AND prop_num > 0
                       THEN prop_num || ' ' || prop_loc ELSE prop_loc END
FROM address_inference.parcels
WHERE state_fips = %(state_fips)s AND town = %(town)s AND prop_loc IS NOT NULL
ORDER BY parcel_id
"""


# Tax-roll spellings E911 never uses (Freeport: 169 of 3,621 numbered lots
# matched no E911 street before these): "LWR MAST LNDG RD" is E911's "LOWER
# MAST LANDING ROAD"; "MAIN ST SF" (South Freeport) is "MAIN STREET SOUTH".
TAX_ROLL_WORDS = {"LWR": "LOWER", "UPR": "UPPER"}
TAX_ROLL_LAST_WORDS = {"SF": "SOUTH"}


def parse_prop_loc(prop_loc):
    """("21 CARRIAGE ROAD") -> (21, "CARRIAGE RD"); None without a house number."""
    import re
    from .street_names import canonical
    m = re.match(r"\s*(\d+)[A-Z]?(?:\s*-\s*\d+[A-Z]?)?\s+(.+)", prop_loc or "")
    if not m or int(m.group(1)) == 0:
        return None
    street = re.sub(r"\s+(?:#\s*)?(?:UNIT|APT|STE|SUITE)\b.*$|\s+#.*$", "", m.group(2).upper())
    words = [TAX_ROLL_WORDS.get(w, w) for w in street.split()]
    if len(words) > 1:
        words[-1] = TAX_ROLL_LAST_WORDS.get(words[-1], words[-1])
    return int(m.group(1)), canonical(" ".join(words))


# Harpswell/Pownal tax rolls keep the number only in prop_num; False = the old
# reading (prop_loc alone), for A/B runs.
LOT_NUMBER_FROM_PROP_NUM = True


def load_lot_addresses(dsn, region, town) -> dict:
    """{(number, canonical street): [parcel_id, ...]}"""
    out = defaultdict(list)
    with psycopg.connect(dsn) as conn:
        if conn.execute("SELECT to_regclass('address_inference.parcels') IS NULL").fetchone()[0]:
            return {}
        for parcel_id, prop_loc in conn.execute(
                LOT_ADDRESSES_SQL if LOT_NUMBER_FROM_PROP_NUM else LOT_ADDRESSES_OLD_SQL,
                {"state_fips": region.state_fips, "town": town}).fetchall():
            key = parse_prop_loc(prop_loc)
            if key:
                out[key].append(parcel_id)
    return dict(out)


# The tax roll's lot wins wherever the lot is: a lot whose number and street
# match takes its biggest building even when no building there is a
# candidate (more than 200 m from the street's TIGER line). Dune Drive's TIGER
# line turns north into the sand at 46 while the real road runs west: the
# tax roll lists 87-143 Dune Drive, each on its own lot, 190-440 m from
# TIGER, and all were "missed".
ASSESSOR_ANY_BUILDING = True

LOT_BUILDINGS_SQL = """
SELECT bp.source_id, s.sqmeters, ST_Y(s.inner_point), ST_X(s.inner_point)
FROM address_inference.building_parcels bp
JOIN address_inference.parcels p ON p.parcel_id = bp.parcel_id AND p.state_fips = bp.state_fips
JOIN address_inference.structures s ON s.state_fips = bp.state_fips AND s.source_id = bp.source_id
WHERE bp.state_fips = %(state_fips)s AND p.town = %(town)s
"""


def load_lot_buildings(dsn, region, town) -> dict:
    """{source_id: (outline m2, lat, lon)} for every building on a tax lot in town."""
    with psycopg.connect(dsn) as conn:
        if conn.execute("SELECT to_regclass('address_inference.building_parcels') IS NULL").fetchone()[0]:
            return {}
        return {sid: (m2, lat, lon) for sid, m2, lat, lon in conn.execute(
            LOT_BUILDINGS_SQL, {"state_fips": region.state_fips, "town": town}).fetchall()}


def assessor_picks(address_df, lot_addresses, parcel_of, size_of, fallback, roof_of=None, positions=None,
                   scored_df=None, lane_neighbors=None):
    """(picks, matched): each address whose number and street the assessor
    gives a tax lot takes that lot's biggest building (lidar roof where seen,
    else its outline); every other address keeps `fallback`'s pick. Only
    buildings in size_of (the candidate set) can be picked."""
    from .street_names import canonical
    roof_of = roof_of or {}
    on_lot = defaultdict(list)
    for sid, lot in parcel_of.items():
        if sid in size_of:
            on_lot[lot].append(sid)
    picks, matched = dict(fallback), set()
    for a in address_df.itertuples():
        lots = lot_addresses.get((int(a.number), canonical(a.street)), [])
        buildings = sorted(b for lot in lots for b in on_lot.get(lot, []))
        if buildings:
            picks[a.id] = max(buildings, key=lambda b: (roof_of[b][0] if b in roof_of and roof_of[b][0] else size_of[b] or 0))
            matched.add(a.id)
    if SHIFT_RUN_MIN:
        ranker = None
        if SHIFT_NEEDS_RANKER and scored_df is not None:
            ranked = scored_df.assign(p=probabilities(scored_df)).sort_values(
                ["address_id", "p", "source_id"], ascending=[True, False, True])
            ranker = ranked.drop_duplicates("address_id").set_index("address_id")["source_id"].to_dict()
        if SHIFT_NEAR_LANE and lane_neighbors is None:
            lane_neighbors = {}
        for aid in shifted_runs(picks, matched, address_df, fallback, SHIFT_RUN_MIN, ranker, parcel_of,
                                lane_neighbors if SHIFT_NEAR_LANE else None, SHIFT_CONTEXT_SHARE):
            picks[aid] = fallback.get(aid)
            matched.discard(aid)
    if ANCHORED and positions and scored_df is not None:
        picks = anchored_fill(picks, matched, address_df, scored_df, positions, parcel_of)
    if SPREAD_WITHIN_LOT and positions:
        within = {b: (roof_of[b][0] if b in roof_of and roof_of[b][0] else size_of[b] or 0) for b in size_of}
        picks = spread_within_lots(picks, address_df, parcel_of, within, positions)
    return picks, matched


# A tax roll out of step with the houses (Curtis Road: the house E911 moved
# to 2 Diamond Drive kept "18 Curtis Road" on the tax roll, so lots 18-28
# each carry the number of the house before) shows as a run of numbers on
# one street side whose tax lot holds the house road order gives a
# *different* address. Such a run is not pinned; road order keeps it.
# Off: it fixes Curtis 18-28 but costs points -- TIGER 80.5% -> 77.9%, E911
# roads 83.9% -> 82.6% at 4 in a row (worse for shorter runs). Of the runs
# it unpinned, the tax roll was right 714 vs road order 10 (TIGER), 71 vs 12
# (E911 roads): road order's own chain shifts look the same from the
# sequence, so it can't tell which source moved.
SHIFT_RUN_MIN = None
# Road order makes one-step chain shifts of its own, which look the same;
# so a step counts only when the ranker alone (no order) picks road
# order's building too.
SHIFT_NEEDS_RANKER = True
# The owner's trigger: only a run beside a lot the tax roll addresses on a
# short lane (a street with at most LANE_MAX_LOTS tax lots in town, like
# "2 DIAMOND DRIVE", the house E911 moved off Curtis Road) -- a new lane
# address is what pushes the main street's tax-roll numbers a house off.
# Still off: the strictest trigger (a 1-lot lane, 3 in a row) fixes Curtis
# 18-28 but its other runs were mostly tax-roll-right (TIGER 44 vs road
# order 5, E911 roads 63 vs 12): TIGER 80.5% -> 80.0%, E911 roads 83.9% ->
# 83.1%. Looser triggers cost more (lanes <= 3 lots: 78.5% / 82.7%).
SHIFT_NEAR_LANE = True
LANE_MAX_LOTS = 1
LANE_NEAR_M = 10
LANE_NEIGHBORS_SQL = """
SELECT DISTINCT n.parcel_id, l.parcel_id
FROM address_inference.parcels l
JOIN address_inference.parcels n
  ON n.state_fips = l.state_fips AND n.parcel_id <> l.parcel_id
 AND ST_DWithin(n.geom::geography, l.geom::geography, %(near_m)s)
 AND n.geom && ST_Expand(l.geom, 0.001)
WHERE l.state_fips = %(state_fips)s AND l.parcel_id = ANY(%(lanes)s)
"""


def load_lane_neighbors(dsn, region, lot_addresses, max_lots=None, near_m=None):
    """{parcel_id: {lane street, ...}}: lots within near_m of a lot the tax
    roll addresses on a short lane (<= max_lots tax lots on that street)."""
    max_lots = LANE_MAX_LOTS if max_lots is None else max_lots
    near_m = LANE_NEAR_M if near_m is None else near_m
    lots_on = defaultdict(set)
    for (_, street), lots in lot_addresses.items():
        lots_on[street].update(lots)
    lane_of = {lot: street for street, lots in lots_on.items() if len(lots) <= max_lots for lot in lots}
    if not lane_of:
        return {}
    out = defaultdict(set)
    with psycopg.connect(dsn) as conn:
        for near, lane in conn.execute(LANE_NEIGHBORS_SQL, {
                "state_fips": region.state_fips, "lanes": list(lane_of), "near_m": near_m}).fetchall():
            out[near].add(lane_of[lane])
    return dict(out)


# The owner's second trigger: a disagreeing run counts only where road order
# agrees with the tax roll on most of the rest of that street side (it
# counted the houses right there, so the tax roll is what's off). None = off:
# best is 90% agreement + 3 in a row, E911 roads 83.9% -> 83.6% (tax roll
# right 26 vs road order 10 in the runs it unpinned), TIGER 80.5% -> 79.6%
# (636 vs 1, and Curtis no longer caught); lower shares cost more.
SHIFT_CONTEXT_SHARE = None
SHIFT_CONTEXT_MIN = 3


def shifted_runs(picks, matched, address_df, fallback, run_min, ranker=None, parcel_of=None,
                 lane_neighbors=None, context_share=None, context_min=None):
    """Addresses (ids) in runs of consecutive matched numbers on one street
    and parity where the tax lot's pick differs from road order's and, for
    at least `run_min` of them, is a building road order gives another
    address -- the same houses, numbered one step off."""
    taken = defaultdict(set)
    for aid, b in fallback.items():
        if b is not None:
            taken[b].add(aid)
    from .street_names import canonical
    sides = defaultdict(lambda: defaultdict(list))
    for a in address_df.itertuples():
        if a.id in matched:
            sides[(a.street, int(a.number) % 2)][int(a.number)].append(a.id)
    out = set()
    context_min = SHIFT_CONTEXT_MIN if context_min is None else context_min
    for (street, _), numbers in sides.items():
        street = canonical(street)
        agree = {n: picks.get(numbers[n][0]) == fallback.get(numbers[n][0]) for n in numbers}

        def context_ok(run):
            if context_share is None:
                return True
            rest = [agree[n] for n in numbers if n not in run]
            return len(rest) >= context_min and sum(rest) / len(rest) >= context_share
        run, shifted = [], 0
        for n in sorted(numbers) + [None]:
            aid = numbers[n][0] if n is not None else None
            b = picks.get(aid) if aid else None
            if aid is not None and b != fallback.get(aid):
                run.append(n)
                shifted += bool(taken.get(b, set()) - {aid}) and (
                    ranker is None or ranker.get(aid) == fallback.get(aid))
                continue
            if shifted >= run_min and context_ok(set(run)) and (lane_neighbors is None or any(
                    lane_neighbors.get((parcel_of or {}).get(picks.get(numbers[m][0])), set())
                    - {street} for m in run)):
                out.update(x for m in run for x in numbers[m])
            run, shifted = [], 0
    return out


# Numbers the tax roll pins to a lot are fixed points along the street: a
# number it doesn't list must land between the pinned numbers around it on
# its side (57 Lower Mast Landing Road, between pinned 51 and 59, had gone
# to 51's house when road order shifted the run on E911 roads).
ANCHORED = True


def anchored_fill(picks, matched, address_df, scored_df, positions, parcel_of=None):
    """Each unmatched address whose pick lies outside the stretch between
    the pinned (matched) numbers just below and above it on its street and
    parity -- from the far end of one anchor's lot to the far end of the
    other's -- takes the ranker's best same-side building inside it, never
    a building already pinned to a number; kept as is when there is no
    anchor on one side or no building inside."""
    parcel_of = parcel_of or {}
    lot_size = Counter(parcel_of.values())
    members = defaultdict(list)
    for b, lot in parcel_of.items():
        members[lot].append(b)
    def lot_positions(street, b):
        lot = parcel_of.get(b)
        group = members[lot] if lot is not None and lot_size[lot] <= LOT_MAX_BUILDINGS else [b]
        return [positions[(street, x)] for x in group if (street, x) in positions]
    p = scored_df.assign(p=probabilities(scored_df))
    if "same_side" in p.columns:
        p = p[p["same_side"].astype(bool)]
    pinned = defaultdict(list)
    pinned_buildings = set()
    rows = list(address_df.itertuples())
    for a in rows:
        b = picks.get(a.id)
        if a.id in matched and b is not None and (a.street, b) in positions:
            pinned[(a.street, int(a.number) % 2)].append((int(a.number), lot_positions(a.street, b)))
            pinned_buildings.add(b)
    out = dict(picks)
    by_address = {aid: g for aid, g in p.groupby("address_id")}
    for a in rows:
        if a.id in matched:
            continue
        n = int(a.number)
        anchors = pinned.get((a.street, n % 2), [])
        below = [t for t in anchors if t[0] < n]
        above = [t for t in anchors if t[0] > n]
        if not below or not above:
            continue
        span = max(below)[1] + min(above)[1]
        lo, hi = min(span) - 1, max(span) + 1
        def ok(x):
            return x not in pinned_buildings and lo <= positions.get((a.street, x), -1e9) <= hi
        b = picks.get(a.id)
        if b is not None and ok(b):
            continue
        g = by_address.get(a.id)
        if g is None:
            continue
        inside = g[[ok(x) for x in g["source_id"]]]
        if len(inside):
            out[a.id] = inside.sort_values(["p", "source_id"], ascending=[False, True]).iloc[0]["source_id"]
    return out
