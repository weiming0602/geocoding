"""Street patterns: number each dead-end street the way its kind of place is
numbered (owner's idea: community and rural streets need different methods,
combined, not one against the other).

    python -m address_inference.patterns me --town Freeport "dbname=geocoding" [--save]

Every simple dead-end street (its TIGER line has exactly one end touching
another road) is one of:

- park: a community whose homes share one big tax lot (at least half its
  buildings on a lot with more than LOT_MAX buildings, like Juniper Drive's
  "0 VERONICA LANE") and about one building per number. Numbered by the
  owner's drive rule: drive in from the entrance, the houses on the right get
  the even numbers smallest first; U-turn at the end, the houses on the right
  on the way back get the odd numbers biggest first. Which side holds the
  evens comes from TIGER's ranges (there is no fixed side in Maine). A house
  is a building whose nearest road is this street -- no roof, driveway or
  model input.
- townhouse: a community with more than TOWNHOUSE_RATIO numbers per building
  (Harvest Ridge Road): ML + road order's townhouse mode (method ml_order).
- rural: everything else: the assessor's lot address, else ML + road order
  (method assessor).

--save writes the picks to address_inference.ml_predictions as method
'pattern' (dead-end streets only) and each street's pattern to
address_inference.street_patterns, for the Training data map. Needs the
assessor and ml_order rows saved first (evaluate --save).

Freeport (254 dead ends, 1,356 numbers): 84.5% right building vs 84.4% for
the tax roll everywhere; 15 community streets (78 numbers). The limit there
is the data (Juniper's houses 1 and 7 have no footprint), not the method.
"""

import argparse
from collections import defaultdict
from datetime import date

import psycopg

from . import dataset
from .regions import load_region

LOT_MAX = 3              # a lot with more buildings is a shared (community) lot
COMMUNITY_SHARE = 0.5    # share of a street's buildings on shared lots
TOWNHOUSE_RATIO = 1.5    # numbers per building that make a townhouse complex

STREETS_SQL = """
WITH segs AS (
  SELECT sms.label_street, array_agg(st.tlid) tlids, ST_LineMerge(ST_Collect(ST_Transform(st.geom, 3857))) g
  FROM address_inference.street_match_segments sms JOIN streets st ON st.tlid = sms.tlid
  WHERE sms.region_id = %(region)s AND sms.town = %(town)s GROUP BY sms.label_street)
SELECT label_street, tlids, ST_AsText(g),
  (SELECT count(*) FROM streets o WHERE NOT (o.tlid = ANY(tlids)) AND ST_DWithin(ST_Transform(o.geom, 3857), ST_StartPoint(g), 3)),
  (SELECT count(*) FROM streets o WHERE NOT (o.tlid = ANY(tlids)) AND ST_DWithin(ST_Transform(o.geom, 3857), ST_EndPoint(g), 3))
FROM segs WHERE GeometryType(g) = 'LINESTRING'
"""

RANGES_SQL = """
SELECT tlid, lfromadd, ltoadd, rfromadd, rtoadd, ST_AsText(ST_Transform(geom, 3857)) FROM streets WHERE tlid = ANY(%s)
"""

# Buildings attached to the street whose nearest road (any street) is one of its segments.
HOUSES_SQL = """
SELECT sms.label_street, bs.source_id, nearest.tlids[1],
       ST_X(ST_Transform(s.inner_point, 3857)), ST_Y(ST_Transform(s.inner_point, 3857)),
       ST_Y(s.inner_point), ST_X(s.inner_point),
       bs.dist_m, nearest.tlids, nearest.dists, s.sqmeters
FROM address_inference.street_match_segments sms
JOIN address_inference.building_segments bs ON bs.tlid = sms.tlid
JOIN address_inference.structures s ON s.source_id = bs.source_id AND s.source <> 'lidar'
CROSS JOIN LATERAL (
  SELECT array_agg(tlid ORDER BY d) tlids, array_agg(d ORDER BY d) dists FROM (
    SELECT o.tlid, ST_Distance(o.geom::geography, s.inner_point::geography) d
    FROM streets o ORDER BY o.geom <-> s.inner_point LIMIT 6) n) nearest
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
"""

LOTS_SQL = "SELECT source_id, parcel_id FROM address_inference.building_parcels"

PREDICTIONS_SQL = """
SELECT * FROM address_inference.ml_predictions
WHERE region_id = %(region)s AND town = %(town)s AND method = ANY(%(methods)s)
"""

CREATE_PATTERNS_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.street_patterns (
    region_id TEXT NOT NULL,
    town TEXT NOT NULL,
    rule TEXT NOT NULL,          -- RULE the picks were made with (plain, ml, ...)
    street TEXT NOT NULL,
    pattern TEXT NOT NULL,       -- park | townhouse | rural
    method TEXT NOT NULL,        -- drive_rule | ml_order | assessor
    buildings INTEGER NOT NULL,
    numbers INTEGER NOT NULL,
    shared_lot_share REAL NOT NULL,
    run_date DATE NOT NULL,
    PRIMARY KEY (region_id, town, rule, street)
)
"""


def side_of(line, p):
    from shapely.geometry import Point  # noqa: F401  (shapely objects passed in)
    t = line.project(p)
    a, b = line.interpolate(max(t - 1, 0)), line.interpolate(min(t + 1, line.length))
    return "left" if (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) > 0 else "right"


def evens_side(line, segments):
    """'left'/'right' of `line` (in travel direction) that TIGER's ranges give the even numbers, by length."""
    from shapely import wkt
    from shapely.geometry import Point
    votes = defaultdict(float)
    for lf, lt, rf, rt, g in segments:
        seg = wkt.loads(g)
        same = line.project(Point(seg.coords[0])) <= line.project(Point(seg.coords[-1]))
        for lo, hi, side in ((lf, lt, "left"), (rf, rt, "right")):
            try:
                lo, hi = int(lo), int(hi)
            except (TypeError, ValueError):
                continue
            if lo % 2 == 0 and hi % 2 == 0:
                votes[side if same else ("right" if side == "left" else "left")] += seg.length
    return max(votes, key=votes.get) if votes else "right"


def drive_rule(numbers, houses, evens):
    """{number: house id}. houses: [(id, distance along the road from the entrance, side)]."""
    odds_side = "left" if evens == "right" else "right"
    going_in = sorted((h for h in houses if h[2] == evens), key=lambda h: h[1])
    coming_back = sorted((h for h in houses if h[2] == odds_side), key=lambda h: -h[1])
    picks = dict(zip(sorted(n for n in numbers if n % 2 == 0), (h[0] for h in going_in)))
    picks.update(zip(sorted((n for n in numbers if n % 2), reverse=True), (h[0] for h in coming_back)))
    return picks


# Owner's smooth-gap rule: a community's homes are evenly spaced along the
# road, so a building past a gap this many times the street's typical
# spacing is not part of the sequence (Juniper Drive: the Veronica Lane
# buildings at 48-59 m, then nothing until the first Juniper house at 96 m).
GAP_FACTOR = 2.5
# ...and each side's numbers sit at evenly spaced slots over the street's
# occupied stretch, so a number whose house is missing stays empty instead of
# shifting the rest (Juniper's odd side: houses at 132 and 158 m are 3 and 5;
# 1 and 7 have no footprint). Leaving a number empty costs this share of the
# typical spacing; leaving a building out costs the same.
SKIP_COST = 0.5


def main_run(houses):
    """The houses (id, along, side) in each side's biggest evenly spaced run:
    a side splits wherever the gap between neighbours on that side is more
    than GAP_FACTOR times the street's typical (median) same-side gap
    (Juniper's odd side: 84 m from the Veronica Lane building to the first
    Juniper house, typical 28 m). Both sides together hide it (typical 25 m
    with the other side's houses in between)."""
    by_side = defaultdict(list)
    for h in houses:
        by_side[h[2]].append(h)
    for hs in by_side.values():
        hs.sort(key=lambda h: h[1])
    gaps = [b[1] - a[1] for hs in by_side.values() for a, b in zip(hs, hs[1:])]
    if len(gaps) < 2:
        return houses, None
    typical = max(sorted(gaps)[len(gaps) // 2], 5.0)
    kept = []
    for hs in by_side.values():
        runs, run = [], [hs[0]]
        for a, b in zip(hs, hs[1:]):
            if b[1] - a[1] > GAP_FACTOR * typical:
                runs.append(run); run = []
            run.append(b)
        runs.append(run)
        kept += max(runs, key=len)
    return kept, typical


def slot_rule(numbers, houses, evens):
    """The drive rule with the smooth-gap rule: {number: house id}, numbers
    with no house at their slot left out."""
    run, typical = main_run(houses)
    if typical is None:
        return drive_rule(numbers, houses, evens)
    lo, hi = min(h[1] for h in run), max(h[1] for h in run)
    picks = {}
    for side, parity in ((evens, 0), ("left" if evens == "right" else "right", 1)):
        nums = sorted(n for n in numbers if n % 2 == parity)  # in travel order on both sides (odds come back biggest first)
        hs = sorted((h for h in run if h[2] == side), key=lambda h: h[1])
        if not nums or not hs:
            continue
        slots = [lo + (hi - lo) * (k / (len(nums) - 1) if len(nums) > 1 else 0.5) for k in range(len(nums))]
        skip = SKIP_COST * typical
        # monotone matching of numbers to houses, each may be skipped
        INF = float("inf")
        n, m = len(nums), len(hs)
        cost = [[INF] * (m + 1) for _ in range(n + 1)]
        back = [[None] * (m + 1) for _ in range(n + 1)]
        cost[0][0] = 0.0
        for i in range(n + 1):
            for j in range(m + 1):
                c = cost[i][j]
                if c == INF:
                    continue
                if i < n and c + skip < cost[i + 1][j]:
                    cost[i + 1][j], back[i + 1][j] = c + skip, (i, j, None)
                if j < m and c + skip < cost[i][j + 1]:
                    cost[i][j + 1], back[i][j + 1] = c + skip, (i, j, None)
                if i < n and j < m:
                    d = c + abs(hs[j][1] - slots[i])
                    if d < cost[i + 1][j + 1]:
                        cost[i + 1][j + 1], back[i + 1][j + 1] = d, (i, j, (nums[i], hs[j][0]))
        i, j = n, m
        while back[i][j] is not None:
            pi, pj, pair = back[i][j]
            if pair:
                picks[pair[0]] = pair[1]
            i, j = pi, pj
    return picks


def across_from_partner(numbers, picks, house_point, line, evens):
    """{number: EPSG:3857 Point} for each number with no house (owner's rule):
    across the road from its partner's house -- odd n from n + 1, even n from
    n - 1 (then the other neighbour) -- set back by its own side's usual
    distance. Juniper Drive: 1 across from 2 lands 14 m from E911's 1, 3
    across from 4 16 m from E911's 3 (no E911 input)."""
    import statistics
    from shapely.geometry import Point
    sides = {0: evens, 1: "left" if evens == "right" else "right"}
    setback = {}
    for parity, side in sides.items():
        ds = [line.distance(house_point[h]) for n, h in picks.items() if n % 2 == parity]
        others = [line.distance(house_point[h]) for h in picks.values()]
        setback[parity] = statistics.median(ds or others) if (ds or others) else None
    out = {}
    for n in numbers:
        if n in picks or setback[n % 2] is None:
            continue
        partners = (n + 1, n - 1) if n % 2 else (n - 1, n + 1)
        partner = next((m for m in partners if m in picks), None)
        if partner is None:
            continue
        along = line.project(house_point[picks[partner]])
        a, b = line.interpolate(max(along - 1, 0)), line.interpolate(min(along + 1, line.length))
        dx, dy = b.x - a.x, b.y - a.y
        norm = (dx * dx + dy * dy) ** 0.5 or 1.0
        nx, ny = -dy / norm, dx / norm  # left of travel
        if sides[n % 2] == "right":
            nx, ny = -nx, -ny
        o = line.interpolate(along)
        out[n] = Point(o.x + nx * setback[n % 2], o.y + ny * setback[n % 2])
    return out


def to_lat_lon(p):
    import math
    lon = p.x * 180 / 20037508.34
    lat = math.degrees(2 * math.atan(math.exp(p.y * math.pi / 20037508.34)) - math.pi / 2)
    return lat, lon


# Numbers a park street's drive rule leaves without a house get an estimated
# point (across_from_partner), status 'estimated', scored by distance.
ESTIMATE_MISSING = True


def classify(houses, numbers, lot_of, lot_size):
    if not houses:
        return "rural", 0.0
    shared = sum(1 for h in houses if lot_size.get(lot_of.get(h), 1) > LOT_MAX) / len(houses)
    if shared < COMMUNITY_SHARE:
        return "rural", shared
    return ("townhouse" if len(numbers) > TOWNHOUSE_RATIO * len(houses) else "park"), shared


# "cut": the drive rule over each side's main evenly spaced run (main_run);
# "plain": the drive rule over every building whose nearest road is the
# street; "slots": cut + evenly spaced slots for missing houses (worse:
# Juniper's odd side fits 5/7 as well as 3/5 -- only the missing houses tell).
RULE = "plain"
# Freeport, park streets / every dead end by the drive rule: plain 22/36 /
# 26.2%; cut 14/36 / 24.2% (a fixed gap cut drops real houses); slots 19/36 /
# 21.1%; ml 15/41 / 30.0% (membership finds the numbered buildings better --
# precision 0.78 vs 0.61 for "nearest road is the street" -- but the drive
# order on top still loses to ML + road order). The saved map uses plain.
# rule "ml": the drive rule over the buildings a model (membership, below)
# says belong to the street's sequence, p >= MEMBER_P.
MEMBER_P = 0.5


def membership_features(street, tlids, line, houses_of, info, lot_of, lot_size):
    """{source_id: feature dict} for every building attached to the street."""
    import numpy as np
    from shapely.geometry import Point  # noqa: F401
    rows = {}
    for sid, (near, p) in houses_of[street].items():
        f = info[(street, sid)]
        other = next((d for t, d in f["near"] if t not in tlids), 500.0)
        rows[sid] = {"along": line.project(p), "side": side_of(line, p), "setback": f["setback"],
                     "other_road_m": other, "m2": f["m2"], "nearest_is_street": float(near in tlids),
                     "shared_lot": float(lot_size.get(lot_of.get(sid), 1) > LOT_MAX),
                     "lot_buildings": float(lot_size.get(lot_of.get(sid), 1))}
    length = max(line.length, 1.0)
    by_side = defaultdict(list)
    for sid, r in rows.items():
        by_side[r["side"]].append(sid)
    gaps = []
    for ids in by_side.values():
        ids.sort(key=lambda i: rows[i]["along"])
        gaps += [rows[b]["along"] - rows[a]["along"] for a, b in zip(ids, ids[1:])]
    typical = max(float(np.median(gaps)) if gaps else length, 5.0)
    m2_med = float(np.median([r["m2"] for r in rows.values()])) if rows else 1.0
    for ids in by_side.values():
        setbacks = [rows[i]["setback"] for i in ids]
        for k, i in enumerate(ids):
            r = rows[i]
            prev_gap = r["along"] - rows[ids[k - 1]]["along"] if k > 0 else r["along"]
            next_gap = rows[ids[k + 1]]["along"] - r["along"] if k + 1 < len(ids) else length - r["along"]
            near_setbacks = setbacks[max(0, k - 2):k] + setbacks[k + 1:k + 3]
            r.update(along_frac=r["along"] / length, prev_gap=prev_gap / typical, next_gap=next_gap / typical,
                     min_gap=min(prev_gap, next_gap) / typical, max_gap=max(prev_gap, next_gap) / typical,
                     setback_vs_neighbours=(r["setback"] / max(float(np.median(near_setbacks)), 1.0)) if near_setbacks else 1.0,
                     other_vs_setback=r["other_road_m"] / max(r["setback"], 1.0), m2_vs_street=r["m2"] / max(m2_med, 1.0),
                     side_buildings=float(len(ids)))
    return rows


MEMBER_FEATURES = ["along_frac", "setback", "other_road_m", "other_vs_setback", "m2", "m2_vs_street", "nearest_is_street",
                   "shared_lot", "lot_buildings", "prev_gap", "next_gap", "min_gap", "max_gap", "setback_vs_neighbours",
                   "side_buildings"]


def membership(dead_ends, houses_of, info, preds_by_street, lot_of, lot_size, folds=5, verbose=True):
    """{(street, source_id): p} that the building holds one of the street's
    numbers, cross-validated by street (a street is never scored by a model
    that saw it). Label: E911 puts one of this street's numbers on it."""
    import lightgbm as lgb
    import numpy as np
    keys, X, y, groups = [], [], [], []
    for g, (street, tlids, line) in enumerate(dead_ends):
        truth = {r["true_building"] for r in preds_by_street.get(street, []) if r["true_building"]}
        for sid, f in membership_features(street, tlids, line, houses_of, info, lot_of, lot_size).items():
            keys.append((street, sid)); X.append([f[c] for c in MEMBER_FEATURES]); y.append(int(sid in truth)); groups.append(g)
    X, y, groups = np.array(X, dtype=float), np.array(y), np.array(groups)
    p = np.zeros(len(y))
    fold_of = groups % folds  # deterministic by street order
    for k in range(folds):
        train, test = fold_of != k, fold_of == k
        model = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=20,
                                   subsample=0.8, subsample_freq=1, colsample_bytree=0.8, random_state=0,
                                   deterministic=True, force_row_wise=True, verbose=-1)
        model.fit(X[train], y[train])
        p[test] = model.predict_proba(X[test])[:, 1]
    if verbose:
        from sklearn.metrics import roc_auc_score
        base = X[:, MEMBER_FEATURES.index("nearest_is_street")]
        pred = p >= MEMBER_P
        print(f"membership: {len(y)} buildings on {len(dead_ends)} dead ends, {y.mean():.0%} hold a number; "
              f"AUC {roc_auc_score(y, p):.3f}; at p>={MEMBER_P}: precision {y[pred].mean():.2f}, recall {pred[y == 1].mean():.2f} | "
              f"nearest-road rule: precision {y[base == 1].mean():.2f}, recall {(base == 1)[y == 1].mean():.2f}")
    return dict(zip(keys, p))


def run(dsn, region, town, save=False, rule=None, all_dead_ends=False):
    """all_dead_ends: score the rule on every dead end (no saving), as a test."""
    rule = RULE if rule is None else rule
    # saved as method 'pattern' (plain drive rule) or 'pattern_<rule>'
    saved_method = "pattern" if rule == "plain" else f"pattern_{rule}"
    from shapely import wkt
    from shapely.geometry import Point
    params = {"region": region.id, "town": town}
    with psycopg.connect(dsn) as conn:
        streets = conn.execute(STREETS_SQL, params).fetchall()
        segments = {r[0]: r[1:] for r in conn.execute(RANGES_SQL, ([t for s in streets for t in s[1]],)).fetchall()}
        houses_of, where = defaultdict(dict), {}
        info = {}
        for street, sid, nearest, x, y, lat, lon, dist, near_tlids, near_dists, m2 in conn.execute(HOUSES_SQL, params).fetchall():
            houses_of[street][sid] = (nearest, Point(x, y))
            where[sid] = (lat, lon)
            prev = info.get((street, sid))
            if prev is None or dist < prev["setback"]:
                info[(street, sid)] = {"setback": dist, "near": list(zip(near_tlids, near_dists)), "m2": m2 or 0.0}
        lot_of = dict(conn.execute(LOTS_SQL).fetchall())
        cur = conn.execute(PREDICTIONS_SQL, {**params, "methods": ["assessor", "ml_order"]})
        cols = [d.name for d in cur.description]
        preds = defaultdict(lambda: defaultdict(list))  # method -> street -> rows
        for row in cur.fetchall():
            r = dict(zip(cols, row))
            preds[r["method"]][r["street"]].append(r)
    lot_size = defaultdict(int)
    for pid in lot_of.values():
        lot_size[pid] += 1

    dead_ends = []
    for street, tlids, line_wkt, start_touch, end_touch in streets:
        if (start_touch > 0) == (end_touch > 0) or not preds["assessor"].get(street):
            continue  # not a simple dead end, or nothing scored on it
        line = wkt.loads(line_wkt)
        if end_touch > 0:
            line = type(line)(list(line.coords)[::-1])  # travel from the entrance
        dead_ends.append((street, tlids, line))
    member = None
    if rule == "ml":
        member = membership(dead_ends, houses_of, info, preds["assessor"], lot_of, lot_size)

    rows, patterns = [], []
    for street, tlids, line in dead_ends:
        if member is not None:
            houses = [(sid, line.project(p), side_of(line, p)) for sid, (near, p) in houses_of[street].items()
                      if member.get((street, sid), 0) >= MEMBER_P]
        else:
            houses = [(sid, line.project(p), side_of(line, p)) for sid, (near, p) in houses_of[street].items()
                      if near in tlids]
        numbers = sorted({r["address_number"] for r in preds["assessor"][street]})
        plain = [sid for sid, (near, p) in houses_of[street].items() if near in tlids]
        pattern, shared = classify(plain, numbers, lot_of, lot_size)
        method = {"park": "drive_rule", "townhouse": "ml_order", "rural": "assessor"}[pattern]
        patterns.append((region.id, town, rule, street, pattern, method, len(houses), len(numbers), shared, date.today()))
        if all_dead_ends:
            pattern, method = "park", "drive_rule"
        evens = evens_side(line, [segments[t] for t in tlids])
        if pattern != "park":
            picks = None
        elif rule == "slots":
            picks = slot_rule(numbers, houses, evens)
        elif rule in ("cut", "ml"):
            picks = drive_rule(numbers, main_run(houses)[0] if rule == "cut" else houses, evens)
        else:
            picks = drive_rule(numbers, houses, evens)
        estimates = {}
        if picks is not None and ESTIMATE_MISSING:
            estimates = across_from_partner(numbers, picks, {sid: p for sid, (near, p) in houses_of[street].items()},
                                            line, evens)
        for r in preds["assessor" if method == "drive_rule" else method][street]:
            r = dict(r, method=saved_method, run_date=date.today())
            if picks is not None:
                pick = picks.get(r["address_number"])
                est = estimates.get(r["address_number"]) if pick is None else None
                lat, lon = where[pick] if pick else to_lat_lon(est) if est is not None else (r["m0_lat"], r["m0_lon"])
                r.update(picked_building=pick, picked_lat=lat if (pick or est is not None) else None,
                         picked_lon=lon if (pick or est is not None) else None,
                         error_m=float(dataset.haversine_m(r["e911_lat"], r["e911_lon"], lat, lon)))
                if est is not None:
                    r["status"] = "estimated"
                elif r["true_building"] is None:
                    r["status"] = "no_building"
                elif pick == r["true_building"]:
                    r["status"] = "right"
                else:
                    # whether the E911 building was a candidate at all: as the saved assessor row says
                    r["status"] = "missed" if r["status"] == "missed" else "wrong"
            rows.append(r)

    scored = defaultdict(lambda: defaultdict(set))
    for r in rows:
        if r["status"] != "no_building":
            scored[(r["street"], r["address_number"])]["ok"].add(r["status"] == "right")
    right = sum(1 for v in scored.values() if True in v["ok"])
    by = defaultdict(int)
    for p in patterns:
        by[p[4]] += 1
    juniper = sorted((r["address_number"], r["status"], r["error_m"]) for r in rows if r["street"].startswith("JUNIPER"))
    print("Juniper:", " ".join(f"{n}:{st}" + (f"({e:.0f} m)" if st == "estimated" else "") for n, st, e in juniper))
    est = {}
    for r in rows:
        if r["status"] == "estimated":
            est[(r["street"], r["address_number"])] = min(est.get((r["street"], r["address_number"]), 1e9), r["error_m"])
    if est:
        print(f"  estimated points for numbers with no house: {len(est)}, within 25 m {sum(e <= 25 for e in est.values())}, "
              f"within 50 m {sum(e <= 50 for e in est.values())}")
    park_numbers = {k for k in scored if any(p[3] == k[0] and p[4] == "park" for p in patterns)}
    pr = sum(1 for k in park_numbers if True in scored[k]["ok"])
    print(f"  park streets: {pr}/{len(park_numbers)} right")
    print(f"{town}: {len(patterns)} dead-end streets ({dict(by)}), {len(scored)} numbers with a building, "
          f"{right} right ({100 * right / max(len(scored), 1):.1f}%)")

    if save:
        with psycopg.connect(dsn) as conn:
            # Derived data: a table from before the `rule` column keeps its rows as rule 'plain'.
            has = conn.execute("SELECT to_regclass('address_inference.street_patterns') IS NOT NULL").fetchone()[0]
            if has and not conn.execute(
                    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'address_inference' "
                    "AND table_name = 'street_patterns' AND column_name = 'rule'").fetchone():
                conn.execute("ALTER TABLE address_inference.street_patterns ADD COLUMN rule TEXT NOT NULL DEFAULT 'plain'")
                conn.execute("ALTER TABLE address_inference.street_patterns DROP CONSTRAINT street_patterns_pkey")
                conn.execute("ALTER TABLE address_inference.street_patterns ADD PRIMARY KEY (region_id, town, rule, street)")
            conn.execute(CREATE_PATTERNS_SQL)
            conn.execute("DELETE FROM address_inference.street_patterns WHERE region_id = %s AND town = %s AND rule = %s",
                         (region.id, town, rule))
            conn.execute("DELETE FROM address_inference.ml_predictions WHERE region_id = %s AND town = %s AND method = %s",
                         (region.id, town, saved_method))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO address_inference.street_patterns "
                                "(region_id, town, rule, street, pattern, method, buildings, numbers, shared_lot_share, run_date) "
                                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)", patterns)
                cur.executemany(f"INSERT INTO address_inference.ml_predictions ({', '.join(cols)}) "
                                f"VALUES ({', '.join(['%s'] * len(cols))})", [[r[c] for c in cols] for r in rows])
        print(f"saved {len(rows)} E911 points as method {saved_method!r}, {len(patterns)} street patterns")
    return rows, patterns


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("--save", action="store_true")
    parser.add_argument("--rule", choices=["plain", "cut", "slots", "ml"], default=None,
                        help=f"how park streets are numbered (default {RULE})")
    parser.add_argument("dsn")
    args = parser.parse_args()
    run(args.dsn, load_region(args.region), args.town, save=args.save, rule=args.rule)


if __name__ == "__main__":
    main()
