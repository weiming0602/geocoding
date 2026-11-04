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


def load_positions(dsn, region, town) -> dict:
    """{(street, source_id): meters along the street}."""
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(POSITIONS_SQL, params).fetchall()
    return {(street, source_id): along for street, source_id, along in rows}


def monotone_assign(P):
    """P[i, j]: probability that number i (ascending) is building j (in road
    order). Returns (total, {i: j}) maximizing the summed probability over
    strictly increasing one-to-one matchings; a number may stay unmatched."""
    k, m = P.shape
    D = np.zeros((k + 1, m + 1))
    back = np.zeros((k + 1, m + 1), dtype=np.int8)
    for i in range(1, k + 1):
        for j in range(m + 1):
            best, how = D[i - 1, j], 0  # number i unmatched
            if j > 0 and D[i, j - 1] > best:
                best, how = D[i, j - 1], 1  # building j unused
            if j > 0 and D[i - 1, j - 1] + P[i - 1, j - 1] > best:
                best, how = D[i - 1, j - 1] + P[i - 1, j - 1], 2
            D[i, j], back[i, j] = best, how
    out, i, j = {}, k, m
    while i > 0:
        how = back[i, j]
        if how == 0:
            i -= 1
        elif how == 1:
            j -= 1
        else:
            out[i - 1] = j - 1
            i, j = i - 1, j - 1
    return D[k, m], out


def probabilities(scored_df) -> pd.Series:
    """Softmax of the ranker's scores within each address."""
    shifted = scored_df["score"] - scored_df.groupby("address_id")["score"].transform("max")
    e = np.exp(shifted)
    return e / e.groupby(scored_df["address_id"]).transform("sum")


def order_constrained_picks(address_df, scored_df, positions, fallback) -> dict:
    """{address_id: source_id}. `fallback` (the ranker's own picks) covers
    addresses the ordering step leaves unmatched or can't place."""
    picks = dict(fallback)
    scored = scored_df.assign(p=probabilities(scored_df))
    addr = address_df[address_df["scorable"]].assign(parity=lambda d: d["number"] % 2)
    number_of = dict(zip(addr["id"], addr["number"]))
    by_address = defaultdict(list)
    for row in scored[["address_id", "source_id", "p"]].itertuples(index=False):
        by_address[row.address_id].append((row.source_id, row.p))

    for (street, _parity), group in addr.groupby(["street", "parity"]):
        # Shared addresses (units in one complex) are one number: average.
        prob = defaultdict(list)
        for address_id in group["id"]:
            for source_id, p in by_address.get(address_id, []):
                if (street, source_id) in positions:
                    prob[(number_of[address_id], source_id)].append(p)
        buildings = sorted({b for _, b in prob})
        if len(buildings) < 2:
            continue
        numbers = sorted(group["number"].unique())
        best = None
        for direction in (1, -1):
            order = sorted(buildings, key=lambda b: direction * positions[(street, b)])
            P = np.array([[np.mean(prob[(n, b)]) if (n, b) in prob else 0.0 for b in order] for n in numbers])
            total, match = monotone_assign(P)
            if best is None or total > best[0]:
                best = (total, {numbers[i]: order[j] for i, j in match.items()})
        for address_id, number in zip(group["id"], group["number"]):
            if number in best[1]:
                picks[address_id] = best[1][number]
    return picks
