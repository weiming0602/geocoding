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
# Extra ranker inputs next to d_rate_len (owner, 2026-11-25, Maquoit Drive: shore lots are wider and take more road
# per number -- 5 to 19 m between neighbors -- so be flexible by lot size):
# WITH_LOCAL_RATE: d_rate_local, meters to the spot on stretch_curve(RATE_LOCAL_WINDOW) through TIGER's own spots;
# WITH_LOT_RATE: d_rate_lots, d_rate_len in units of the candidate's lot frontage on the street (min LOT_RATE_MIN_M).
# Both off: Freeport 2026-11-25 vs 2063.5 right -- local -41, lots -20.5, both -11 (Webster Road -10..-15 each time).
WITH_LOCAL_RATE = False
WITH_LOT_RATE = False
LOT_RATE_MIN_M = 15.0
_LOCAL: dict = {}  # street -> local curve (WITH_LOCAL_RATE)
_LOT_FRONT: dict = {}  # (street, source_id) -> its lot's frontage m on the street (WITH_LOT_RATE)
LOT_FRONT_SQL = """
SELECT m.label_street, bp.source_id::text, sum(pf.frontage_m)
FROM address_inference.street_match_segments m
JOIN address_inference.parcel_frontage pf ON pf.tlid = m.tlid
JOIN address_inference.building_parcels bp ON bp.parcel_id = pf.parcel_id
WHERE m.town = %(town)s
GROUP BY 1, 2
"""
# Off until proven on every town (owner: prove it).
RATE_SPOTS = True  # 2026-11-15, with order.MATCH_BONUS 0.6: 7 towns 13,785 -> 14,238 right numbers (Freeport -1)
# Also give the ranker the street's own meters per number (street_rate_m).
WITH_STREET_RATE = False
RATE_MIN_NUMBERS = 5
# Leave numbers without a TIGER spot out of the direction (the bug fix below); False = the old behavior, for A/B only.
SKIP_NAN_SPOTS = False  # 2026-11-17: fix alone Harpswell -34.7; with STRETCH_MIN_M=3000, 7 towns +14.8 but Freeport -29, Gray -34 -- off

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


# Long roads: one steady rate drifts by tens of meters over many km (Harpswell Islands Road: 18.5 km, 7.7 m per
# number on average). With STRETCH_MIN_M set, a road at least that long gets its spots from a curve: for each of
# its numbers, a robust (Theil-Sen) line through the TIGER spots of the street's numbers within STRETCH_WINDOW of
# it, kept moving one way along the road. None = one rate per street.
STRETCH_MIN_M = None
STRETCH_WINDOW = 60
_STRETCH: dict = {}  # street -> (numbers, along_m) of its curve, set by street_spots
# "theil": every street with RATE_MIN_NUMBERS+ TIGER spots gets its spots from one robust (Theil-Sen) line
# through (number, TIGER spot) instead of start + n x length/top. Maquoit Drive, Freeport: numbers start at 39
# ~50 m from TIGER's line start and top out at 159, so length/top put 70's spot 93 m ahead of its house
# (owner's Maquoit case, 2026-11-24); the fit through TIGER's own ranges puts it 7 m off. None = off.
RATE_FIT = None
# Only where TIGER's meters per number are at least this share of length/top: a subdivision lane with
# placeholder ranges (Gray's Maggie Lane: numbers to 30, TIGER's to ~99) gives a far too flat fit (2026-11-24,
# Freeport+Gray median spot error by street: gated at 0.5 keeps 53 of the 65 streets the fit improves by 20 m+
# and drops 146 of the 220 it worsens). None = no gate.
RATE_FIT_MIN_RATIO = 0.5
# "local": every street with RATE_MIN_NUMBERS+ TIGER spots gets stretch_curve with RATE_LOCAL_WINDOW -- the rate
# measured near each number, piece by piece, not over the whole street (owner, 2026-11-25, 60 Maquoit Drive: 39-58
# are packed ~4 m/number on TIGER's 120 m piece 50-58, the street averages ~6 m, so 60's spot fell 130 m ahead on
# 78's house and road order slid 60-76 back one house).
RATE_LOCAL_WINDOW = 20


def stretch_curve(ns, qs, direction, window=None):
    """(sorted distinct numbers, smoothed meters along) from the street's (number, TIGER spot) pairs."""
    order_ = np.argsort(ns)
    ns, qs = ns[order_], qs[order_]
    uniq = np.unique(ns)
    fit = []
    for n in uniq:
        w = np.abs(ns - n) <= (STRETCH_WINDOW if window is None else window)
        x, y = ns[w], qs[w]
        if len(set(x)) >= 2:
            i, j = np.triu_indices(len(x), 1)
            dx = x[j] - x[i]
            ok = dx != 0
            slope = float(np.median((y[j] - y[i])[ok] / dx[ok]))
            fit.append(float(np.median(y - slope * x)) + slope * n)
        else:
            fit.append(float(np.median(y)))
    fit = np.array(fit)
    fit = np.maximum.accumulate(fit) if direction > 0 else np.minimum.accumulate(fit)
    return uniq, fit


def theil_line(ns, qs, direction, len_rate=None):
    """(sorted distinct numbers, along_m on one Theil-Sen line), or None when too few spots or the slope
    disagrees with the street's direction."""
    ok = ~np.isnan(qs)
    ns, qs = ns[ok], qs[ok]
    if len(set(ns)) < RATE_MIN_NUMBERS:
        return None
    i, j = np.triu_indices(len(ns), 1)
    dx = ns[j] - ns[i]
    keep = dx != 0
    slope = float(np.median((qs[j] - qs[i])[keep] / dx[keep]))
    if slope * direction <= 0:
        return None
    if RATE_FIT_MIN_RATIO is not None and len_rate and abs(slope) < RATE_FIT_MIN_RATIO * len_rate:
        return None
    icpt = float(np.median(qs - slope * ns))
    uniq = np.unique(ns)
    return uniq, icpt + slope * uniq


def street_spots(dsn, region, town, address_df) -> dict:
    """{street: (start_m, direction +1/-1, rate_len m/number, length_m)} plus key None -> rate_town."""
    _STRETCH.clear()
    _LOCAL.clear()
    _LOT_FRONT.clear()
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    a = address_df
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        if WITH_LOT_RATE:
            _LOT_FRONT.update({(st, b): float(f) for st, b, f in conn.execute(LOT_FRONT_SQL, {"town": town})})
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
        # numbers without a TIGER spot (M0) give NaN -- leave them out, or np.std is NaN and the direction quietly
        # defaulted to +1 (Harpswell Islands Road: 7 of 335 without a spot, spots reversed, 2025 put 12.8 km off)
        all_ns = ns
        ok = ~np.isnan(qs) if SKIP_NAN_SPOTS else np.ones(len(qs), bool)
        ns, qs = ns[ok], qs[ok]
        if len(qs) and len(set(ns)) >= 2 and np.std(qs) > 0:
            direction = 1 if np.corrcoef(ns, qs)[0, 1] >= 0 else -1
        else:
            direction = 1
        top = all_ns.max()
        if top <= 0 or length <= 0:
            continue
        out[street] = (0.0 if direction > 0 else length, direction, length / top, length, len(set(ns)))
        if STRETCH_MIN_M is not None and length >= STRETCH_MIN_M and len(set(ns)) >= 10:
            _STRETCH[street] = stretch_curve(ns, qs, direction)
        if WITH_LOCAL_RATE and len(set(ns[~np.isnan(qs)])) >= RATE_MIN_NUMBERS:
            ok_l = ~np.isnan(qs)
            _LOCAL[street] = stretch_curve(ns[ok_l], qs[ok_l], direction, RATE_LOCAL_WINDOW)
        if RATE_FIT == "local" and len(set(ns[~np.isnan(qs)])) >= RATE_MIN_NUMBERS:
            ok_q = ~np.isnan(qs)
            _STRETCH[street] = stretch_curve(ns[ok_q], qs[ok_q], direction, RATE_LOCAL_WINDOW)
        elif RATE_FIT == "theil":
            fit = theil_line(ns, qs, direction, length / top)
            if fit is not None:
                _STRETCH[street] = fit
    rates = [v[2] for v in out.values() if v[4] >= RATE_MIN_NUMBERS]
    out[None] = float(np.median(rates)) if rates else None
    return out


# Road order: a candidate at its number's road-start spot gets RATE_BONUS * exp(-(d_rate_len / RATE_SIGMA_M)^2)
# added to its probability before road order (89 Allen Point Road, Harpswell: its own house 37 m from 89's
# spot, the house road order gave it 230 m; TIGER's interpolation is ~350 m off for both, so the ranker
# couldn't tell them apart). None = off.
RATE_BONUS = None
RATE_SIGMA_M = 50.0


def rate_rescore(scored):
    """scored with each candidate raised near its number's road-start spot (RATE_BONUS)."""
    if RATE_BONUS is None or "d_rate_len" not in scored.columns:
        return scored
    s = scored["score"]
    p = np.exp(s - s.groupby(scored["address_id"]).transform("max"))
    p = p / p.groupby(scored["address_id"]).transform("sum")
    d = scored["d_rate_len"].to_numpy()
    bonus = np.where(np.isnan(d), 0.0, RATE_BONUS * np.exp(-(np.nan_to_num(d) / RATE_SIGMA_M) ** 2))
    out = scored.copy()
    out["score"] = np.log(np.clip(p.to_numpy() + bonus, 1e-12, None))
    return out


def add_rate_features(candidate_df, address_df, spots, positions) -> pd.DataFrame:
    """candidate_df plus RATE_COLS (NaN where the street or the building's position is unknown)."""
    rate_town = spots.get(None)
    number_of = dict(zip(address_df["id"], address_df["number"]))
    d_len, d_town, rates, d_local, d_lots = [], [], [], [], []
    for aid, street, sid in zip(candidate_df["address_id"], candidate_df["street"], candidate_df["source_id"]):
        s = spots.get(street)
        q = positions.get((street, sid))
        if s is None or q is None:
            d_len.append(np.nan); d_town.append(np.nan); rates.append(np.nan); d_local.append(np.nan)
            d_lots.append(np.nan)
            continue
        start, direction, rate_len, _length, _k = s
        rates.append(rate_len)
        n = number_of[aid]
        curve = _STRETCH.get(street)
        spot = (float(np.interp(n, curve[0], curve[1])) if curve is not None
                else start + direction * n * rate_len)
        d_len.append(abs(q - spot))
        loc = _LOCAL.get(street)
        d_local.append(abs(q - float(np.interp(n, loc[0], loc[1]))) if loc is not None else np.nan)
        front = _LOT_FRONT.get((street, str(sid)))
        d_lots.append(abs(q - spot) / max(front or 0.0, LOT_RATE_MIN_M))
        d_town.append(abs(q - (start + direction * n * rate_town)) if rate_town else np.nan)
    out = candidate_df.assign(d_rate_len=d_len, d_rate_town=d_town)
    if WITH_LOCAL_RATE:
        out = out.assign(d_rate_local=d_local)
    if WITH_LOT_RATE:
        out = out.assign(d_rate_lots=d_lots)
    if WITH_STREET_RATE:
        # the street's own meters per number: lets the ranker learn where the
        # distance measure holds (rural roads ~7.5 m) and where it doesn't
        # (in-town streets numbered by older, denser rules)
        out = out.assign(street_rate_m=rates)
    return out
