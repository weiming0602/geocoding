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


def monotone_assign(P, share_penalty=None):
    """P[i, j]: score for number i (ascending) on building j (in road
    order). Returns (total, {i: j}) maximizing the summed score over
    assignments where buildings never go backwards along the road; a number
    may stay unmatched, and a number may take the same building as the
    number before it for SHARE_PENALTY (None = SHARE_PENALTY; use inf for
    strictly one number per building)."""
    penalty = SHARE_PENALTY if share_penalty is None else share_penalty
    k, m = P.shape
    NEG = -np.inf
    # D[i, j]: best for numbers < i using buildings < j.
    # M[i, j]: best for numbers < i with number i-1 on building j-1.
    D = np.zeros((k + 1, m + 1))
    M = np.full((k + 1, m + 1), NEG)
    back_d = np.zeros((k + 1, m + 1), dtype=np.int8)  # 0 skip number, 1 skip building, 2 from M
    back_m = np.zeros((k + 1, m + 1), dtype=np.int8)  # 0 new building, 1 share with number before
    for i in range(1, k + 1):
        for j in range(m + 1):
            if j > 0:
                new = D[i - 1, j - 1] + P[i - 1, j - 1]
                share = M[i - 1, j] + P[i - 1, j - 1] - penalty if np.isfinite(penalty) else NEG
                M[i, j], back_m[i, j] = (share, 1) if share > new else (new, 0)
            best, how = D[i - 1, j], 0
            if j > 0 and D[i, j - 1] > best:
                best, how = D[i, j - 1], 1
            if M[i, j] > best:
                best, how = M[i, j], 2
            D[i, j], back_d[i, j] = best, how
    out, i, j, in_m = {}, k, m, False
    while i > 0:
        if in_m:
            out[i - 1] = j - 1
            if back_m[i, j] == 1:
                i -= 1  # number before shares building j-1: stay in M
            else:
                i, j, in_m = i - 1, j - 1, False
            continue
        how = back_d[i, j]
        if how == 0:
            i -= 1
        elif how == 1:
            j -= 1
        else:
            in_m = True
    return D[k, m], out


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
                            claim_min_p=None, other_road_closer_m=None) -> dict:
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
    scored = scored_df.assign(p=probabilities(scored_df))
    if same_side_only:
        scored = scored[scored["same_side"].astype(bool)]
    limit = OTHER_ROAD_CLOSER_M if other_road_closer_m is None else other_road_closer_m
    if limit is not None and "dist_vs_nearest_road" in scored.columns:
        scored = scored[~(scored["dist_vs_nearest_road"] >= limit)]
    addr = address_df[address_df["scorable"]].assign(parity=lambda d: d["number"] % 2)
    # A number with several address points (units, outlets, a complex
    # spread over buildings -- downtown Main Street) isn't one house: its
    # points can sit in different buildings, so it stays out of the
    # one-building-per-number assignment and keeps the ranker's own picks.
    number_of = dict(zip(addr["id"], addr["number"]))
    by_address = defaultdict(list)
    for row in scored[["address_id", "source_id", "p"]].itertuples(index=False):
        by_address[row.address_id].append((row.source_id, row.p))

    groups = dict(tuple(addr.groupby(["street", "parity"])))
    if street_order is not None:
        rank = {st: i for i, st in enumerate(street_order)}
        keys = sorted(groups, key=lambda key: (rank.get(key[0], len(rank)), key))
    else:
        keys = sorted(groups)
    claimed = set()

    for street, _parity in keys:
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
        best = None
        for direction in (1, -1):
            order = sorted(buildings, key=lambda b: direction * positions[(street, b)])
            P = np.array([[np.mean(prob[(n, b)]) if (n, b) in prob else np.nan for b in order] for n in numbers])
            # MATCH_BONUS: placing a number always beats leaving it out, so
            # every number gets a building in road order when the side has
            # enough; a non-candidate pair is never allowed.
            P = np.where(np.isnan(P), -1e9, P + rank_weight * rank_fit + MATCH_BONUS)
            total, match = monotone_assign(P)
            if best is None or total > best[0]:
                best = (total, {numbers[i]: order[j] for i, j in match.items()})
        for address_id, number in zip(group["id"], group["number"]):
            if number in best[1]:
                picks[address_id] = best[1][number]
        if street_order is not None:
            min_p = CLAIM_MIN_P if claim_min_p is None else claim_min_p
            claimed.update(b for n, b in best[1].items() if np.mean(prob[(n, b)]) >= min_p)
    return picks
