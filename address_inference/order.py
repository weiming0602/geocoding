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

import numpy as np
import pandas as pd
import psycopg

# Distance along each Stage 1b street, merged into one line. Streets whose
# segments don't merge into a single line (forks, gaps) get no positions
# and keep the ranker's own picks.
POSITIONS_SQL = """
WITH lines AS (
    SELECT sms.label_street AS street, ST_LineMerge(ST_Union(s.geom)) AS g
    FROM address_inference.street_match_segments sms
    JOIN streets s ON s.tlid = sms.tlid
    WHERE sms.region_id = %(region)s AND sms.town = %(town)s
    GROUP BY sms.label_street
)
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
DRIVEWAY_CORNER_RATIO = 3.0
DRIVEWAY_SET_BACK_M = 40

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
JOIN streets s ON s.tlid = sms.tlid
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
WITH lines AS (
    SELECT sms.label_street AS street, ST_LineMerge(ST_Union(s.geom)) AS g
    FROM address_inference.street_match_segments sms
    JOIN streets s ON s.tlid = sms.tlid
    WHERE sms.region_id = %(region)s AND sms.town = %(town)s
    GROUP BY sms.label_street
), touch AS (
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
WITH lines AS (
    SELECT sms.label_street AS street, ST_LineMerge(ST_Union(s.geom)) AS g
    FROM address_inference.street_match_segments sms
    JOIN streets s ON s.tlid = sms.tlid
    WHERE sms.region_id = %(region)s AND sms.town = %(town)s
    GROUP BY sms.label_street
), ends AS (
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
WITH lines AS (
    SELECT sms.label_street AS street, ST_LineMerge(ST_Union(s.geom)) AS g
    FROM address_inference.street_match_segments sms
    JOIN streets s ON s.tlid = sms.tlid
    WHERE sms.region_id = %(region)s AND sms.town = %(town)s
    GROUP BY sms.label_street
), entries AS (
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


def load_positions(dsn, region, town, by_lot=BY_LOT, entry_min_back_m=None, entry_max_off_m=None) -> dict:
    """{(street, source_id): meters along the street}. by_lot: on which
    streets a building on an ordinary tax lot that fronts the street takes
    the lot's frontage position (LOT_POSITIONS_SQL) instead of its own
    projection -- "coastal" (dead ends near the shore), "within" (coastal, and
    elsewhere the projection kept inside the lot's frontage), True (all), False."""
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    with psycopg.connect(dsn) as conn:
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
SHARE_PENALTY = float("inf")


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
    return ((df["drive_best"] == 1) & (df["drive_off_m"] <= allowed)
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
    cap = (MAX_PER_BUILDING if max_per_building is None else max_per_building) if np.isfinite(penalty) else 1
    k, m = P.shape
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
                M[c, i, j] = M[c - 1, i - 1, j] + P[i - 1, j - 1] - penalty
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
        how = back_d[i, j]
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
                    for size in range(1, TOWNHOUSE_MAX_NUMBERS + 1):
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
MATCH_BONUS = 0.3


def order_constrained_picks(address_df, scored_df, positions, fallback,
                            rank_weight=RANK_WEIGHT, same_side_only=True, street_order=None,
                            claim_min_p=None, other_road_closer_m=None,
                            townhouse_ratio=None, townhouse_share_penalty=None,
                            joint_townhouses=True, property_slot_bonus=None, accessory_max_ratio=None,
                            use_range_direction=True, extra_small_penalty=None, lock_min_points=None,
                            pool_bonus=None, driveway_rules=None) -> dict:
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
    driveway_rules = DRIVEWAY_RULES if driveway_rules is None else driveway_rules
    property_bonus = PROPERTY_SLOT_BONUS if property_slot_bonus is None else property_slot_bonus
    townhouse_ratio = TOWNHOUSE_RATIO if townhouse_ratio is None else townhouse_ratio
    townhouse_share_penalty = TOWNHOUSE_SHARE_PENALTY if townhouse_share_penalty is None else townhouse_share_penalty
    scored = scored_df.assign(p=probabilities(scored_df))
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
        scored = scored[~(scored["drive_ratio"] >= ratio)]
    # A pool within POOL_HOME_M marks a home (owner's rule): never a shed,
    # never a "much smaller extra", and a small boost in the assignment.
    home_pool = (scored["pool_m"] <= POOL_HOME_M) if "pool_m" in scored.columns else pd.Series(False, index=scored.index)
    lane = (scored["lane_end"].astype(bool) if "lane_end" in scored.columns else lane_end(scored)) \
        if driveway_rules else pd.Series(False, index=scored.index)
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
    if same_side_only:
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
                side_ok |= bool(homes) and len(nums) >= townhouse_ratio * len(homes) and dens >= TOWNHOUSE_MIN_DENSITY
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
                      and density >= TOWNHOUSE_MIN_DENSITY)
        share = townhouse_share_penalty if townhouses else None
        candidates = home_buildings if townhouses else buildings
        best = None
        for direction in direction_of.get(street, (1, -1)):
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
            P = np.where(np.isnan(P), -1e9, P + fit + MATCH_BONUS)
            total, match = monotone_assign(P, share_penalty=share)
            if best is None or total > best[0]:
                best = (total, {numbers[i]: order[j] for i, j in match.items()})
        for address_id, number in zip(group["id"], group["number"]):
            if number in best[1]:
                picks[address_id] = best[1][number]
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


def lot_picks(address_df, scored_df, positions, fallback, parcel_of, lot_reserve_p=None, roof_of=None,
              **kwargs) -> dict:
    """order_constrained_picks with each multi-building TAX LOT as one place
    along the road (owner's matrix rule: lots are numbered in order, not
    buildings). Lot 42 Brickyard Cove has two houses, one in front of 22's
    house along the road and one past it; as separate places, 22 took the
    front one and every later number shifted. A lot's position is the
    mean of its buildings'; its probability for an address the sum of
    theirs; the building finally picked is the one the ranker liked best.
    parcel_of: {source_id: parcel id}; buildings without one stay single."""
    df = scored_df.assign(p=probabilities(scored_df))
    lot_size = defaultdict(int)
    for pid in parcel_of.values():
        lot_size[pid] += 1
    # Ordinary lots only: a condo or apartment parcel (Harvest Ridge Road's
    # townhouses, 2 Village View) holds many numbered buildings.
    key = {b: ("lot:" + pid if 1 < lot_size[pid] <= LOT_MAX_BUILDINGS else b) for b, pid in parcel_of.items()}
    df["place"] = df["source_id"].map(lambda b: key.get(b, b))
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
    for col, how in (("dist_vs_nearest_road", "min"), ("d_m0", "min"), ("sqmeters", "max"),
                     ("parcel_size_ratio", "max"), ("parcel_buildings", "min"), ("parcel_area_m2", "max"),
                     ("pool_m", "min"), ("drive_ratio", "min"), ("drive_best", "max"), ("dist_road", "min"),
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
LOT_ADDRESSES_SQL = """
SELECT parcel_id, prop_loc FROM address_inference.parcels
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


def load_lot_addresses(dsn, region, town) -> dict:
    """{(number, canonical street): [parcel_id, ...]}"""
    out = defaultdict(list)
    with psycopg.connect(dsn) as conn:
        if conn.execute("SELECT to_regclass('address_inference.parcels') IS NULL").fetchone()[0]:
            return {}
        for parcel_id, prop_loc in conn.execute(
                LOT_ADDRESSES_SQL, {"state_fips": region.state_fips, "town": town}).fetchall():
            key = parse_prop_loc(prop_loc)
            if key:
                out[key].append(parcel_id)
    return dict(out)


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
                                lane_neighbors if SHIFT_NEAR_LANE else None):
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


def shifted_runs(picks, matched, address_df, fallback, run_min, ranker=None, parcel_of=None,
                 lane_neighbors=None):
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
    for (street, _), numbers in sides.items():
        street = canonical(street)
        run, shifted = [], 0
        for n in sorted(numbers) + [None]:
            aid = numbers[n][0] if n is not None else None
            b = picks.get(aid) if aid else None
            if aid is not None and b != fallback.get(aid):
                run.append(n)
                shifted += bool(taken.get(b, set()) - {aid}) and (
                    ranker is None or ranker.get(aid) == fallback.get(aid))
                continue
            if shifted >= run_min and (lane_neighbors is None or any(
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
