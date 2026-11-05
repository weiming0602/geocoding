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

from collections import defaultdict

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

# A street only claims a building it's this sure of (the ranker's
# probability for that pair): a wrong claim on a main road would otherwise
# push every number on the side street off by one (165 Flying Point Road
# taking an Arrowhead Ridge Road house).
CLAIM_MIN_P = 0.3

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


def load_positions(dsn, region, town) -> dict:
    """{(street, source_id): meters along the street}."""
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(POSITIONS_SQL, params).fetchall()
    return {(street, source_id): along for street, source_id, along in rows}


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


# A building holds at most this many numbers of one parity (owner's rule:
# a townhouse building on one side has one or two numbers; a gap in the
# numbers is where the next building starts).
MAX_PER_BUILDING = 2


def monotone_assign(P, share_penalty=None, max_per_building=None):
    """P[i, j]: score for number i (ascending) on building j (in road
    order). Returns (total, {i: j}) maximizing the summed score over
    assignments where buildings never go backwards along the road; a number
    may stay unmatched, and up to `max_per_building` consecutive numbers
    may share a building, each extra one costing `share_penalty` (None =
    SHARE_PENALTY; inf = strictly one number per building)."""
    penalty = SHARE_PENALTY if share_penalty is None else share_penalty
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
            best, how = D[i - 1, j], 0
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


def _assign_townhouse_street(street, rows, p_both, side_of, positions, home, claimed, share_penalty):
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
    for direction in (1, -1):
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
                            joint_townhouses=True, property_slot_bonus=None) -> dict:
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
    property_bonus = PROPERTY_SLOT_BONUS if property_slot_bonus is None else property_slot_bonus
    townhouse_ratio = TOWNHOUSE_RATIO if townhouse_ratio is None else townhouse_ratio
    townhouse_share_penalty = TOWNHOUSE_SHARE_PENALTY if townhouse_share_penalty is None else townhouse_share_penalty
    scored = scored_df.assign(p=probabilities(scored_df))
    limit = OTHER_ROAD_CLOSER_M if other_road_closer_m is None else other_road_closer_m
    if limit is not None and "dist_vs_nearest_road" in scored.columns:
        scored = scored[~(scored["dist_vs_nearest_road"] >= limit)]
    both_sides = scored  # townhouse streets match both parities together
    if same_side_only:
        scored = scored[scored["same_side"].astype(bool)]
    addr = address_df[address_df["scorable"]].assign(parity=lambda d: d["number"] % 2)
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
                                                claimed, townhouse_share_penalty)
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
                if (street, source_id) in positions and source_id not in claimed:
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
        for direction in (1, -1):
            order = sorted(candidates, key=lambda b: direction * positions[(street, b)])
            P = np.array([[np.mean(prob[(n, b)]) if (n, b) in prob else np.nan for b in order] for n in numbers])
            if townhouses:
                slot = (np.arange(k) * len(order)) // k  # number i's building, dealt out evenly in road order
                P = P + TOWNHOUSE_SLOT_BONUS * (np.arange(len(order))[None, :] == slot[:, None])
            elif property_bonus and 2 <= k < len(home_buildings):
                homes_in_order = [b for b in order if (street, b) in home]
                along = np.array([positions[(street, b)] * direction for b in homes_in_order])
                cuts = sorted(np.argsort(np.diff(along))[::-1][: k - 1] + 1)  # widest gaps
                group_of = {b: int(np.searchsorted(cuts, idx, side="right")) for idx, b in enumerate(homes_in_order)}
                in_slot = np.array([[group_of.get(b, -1) == i for b in order] for i in range(k)])
                P = P + property_bonus * in_slot
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
