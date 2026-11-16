"""Where the addresser put each number: distance from the road's start (owner, 2026-11-15).

Maine E911 numbers a road by measuring from its start (Bayview Road, Harpswell: number ~= 7.6 m x n
from the start along the whole road, ~210 numbers/mile, campus drive included). TIGER's ranges are
interpolated piece by piece and can bunch a road's last numbers into a short piece (Bayview 220-283 all
within ~60 m of each other), which leaves the ranker unable to tell those houses apart.

For each street (order.street_lines' merged line), label-free:
- direction: which end the numbers grow from -- the sign of number vs. TIGER's interpolated point (M0)
  along the line;
- start: that end of the line;
- rate_len: line length / the street's highest number (E911's number list is an input, not a label);
- rate_town: median rate_len over the town's streets with RATE_MIN_NUMBERS+ numbers.
Each candidate gets d_rate_len / d_rate_town: meters along the road between where the building sits
(order.load_positions) and start + n x rate.
"""
from collections import defaultdict

import numpy as np
import pandas as pd
import psycopg

from .street_lines import street_lines

RATE_COLS = ["d_rate_len", "d_rate_town"]
# Off until proven on every town (owner: prove it).
RATE_SPOTS = True  # 2026-11-15, with order.MATCH_BONUS 0.6: 7 towns 13,785 -> 14,238 right numbers (Freeport -1)
# Also give the ranker the street's own meters per number (street_rate_m).
WITH_STREET_RATE = False
RATE_MIN_NUMBERS = 5

M0_ALONG_SQL = """
SELECT a.id, ST_LineLocatePoint(l.g, ST_SetSRID(ST_MakePoint(a.lon, a.lat), 4326)) * ST_Length(l.g::geography),
       ST_Length(l.g::geography)
FROM unnest(%(ids)s::text[], %(streets)s::text[], %(lons)s::float8[], %(lats)s::float8[]) AS a(id, street, lon, lat)
JOIN street_lines l ON l.street = a.street
WHERE ST_GeometryType(l.g) = 'ST_LineString'
"""


# Streets numbered in sequence rather than by distance -- one number per house,
# same-side steps of 2 (Freeport's Holbrook Street: 5, 7, 11, 13 / 6, 8, 10, 12;
# rate_spots cost it 26 numbers) -- get no rate features when the median step
# between a side's distinct numbers is under this. None = no gate.
RATE_MIN_GAP = None


def median_step(numbers) -> float:
    """Median gap between consecutive distinct numbers of the same parity (both sides pooled)."""
    steps = []
    distinct = sorted(set(int(n) for n in numbers))
    for parity in (0, 1):
        side = [n for n in distinct if n % 2 == parity]
        steps += [b - a for a, b in zip(side, side[1:])]
    return float(np.median(steps)) if steps else float("inf")


def street_spots(dsn, region, town, address_df) -> dict:
    """{street: (start_m, direction +1/-1, rate_len m/number, length_m)} plus key None -> rate_town."""
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    a = address_df
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        rows = conn.execute(M0_ALONG_SQL, {
            "ids": [str(x) for x in a["id"]], "streets": list(a["street"]),
            "lons": [float(x) for x in a["m0_lon"]], "lats": [float(x) for x in a["m0_lat"]]}).fetchall()
    along = {aid: (q, length) for aid, q, length in rows}
    by_street = defaultdict(list)
    for aid, street, n in zip(a["id"], a["street"], a["number"]):
        if str(aid) in along:
            q, length = along[str(aid)]
            by_street[street].append((int(n), q, length))
    out = {}
    for street, pts in by_street.items():
        if RATE_MIN_GAP is not None and median_step(p[0] for p in pts) < RATE_MIN_GAP:
            continue  # numbered in sequence (Holbrook Street), not by distance

        ns = np.array([p[0] for p in pts], float)
        qs = np.array([p[1] for p in pts], float)
        length = pts[0][2]
        if len(set(ns)) >= 2 and np.std(qs) > 0:
            direction = 1 if np.corrcoef(ns, qs)[0, 1] >= 0 else -1
        else:
            direction = 1
        top = ns.max()
        if top <= 0 or length <= 0:
            continue
        out[street] = (0.0 if direction > 0 else length, direction, length / top, length, len(set(ns)))
    rates = [v[2] for v in out.values() if v[4] >= RATE_MIN_NUMBERS]
    out[None] = float(np.median(rates)) if rates else None
    return out


def add_rate_features(candidate_df, address_df, spots, positions) -> pd.DataFrame:
    """candidate_df plus RATE_COLS (NaN where the street or the building's position is unknown)."""
    rate_town = spots.get(None)
    number_of = dict(zip(address_df["id"], address_df["number"]))
    d_len, d_town, rates = [], [], []
    for aid, street, sid in zip(candidate_df["address_id"], candidate_df["street"], candidate_df["source_id"]):
        s = spots.get(street)
        q = positions.get((street, sid))
        if s is None or q is None:
            d_len.append(np.nan); d_town.append(np.nan); rates.append(np.nan)
            continue
        start, direction, rate_len, _length, _k = s
        rates.append(rate_len)
        n = number_of[aid]
        d_len.append(abs(q - (start + direction * n * rate_len)))
        d_town.append(abs(q - (start + direction * n * rate_town)) if rate_town else np.nan)
    out = candidate_df.assign(d_rate_len=d_len, d_rate_town=d_town)
    if WITH_STREET_RATE:
        # the street's own meters per number: lets the ranker learn where the
        # distance measure holds (rural roads ~7.5 m) and where it doesn't
        # (in-town streets numbered by older, denser rules)
        out = out.assign(street_rate_m=rates)
    return out
