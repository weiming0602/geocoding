"""Stages 3-4: train the building ranker on E911 labels and score every
method against E911.

    python -m address_inference.evaluate "dbname=geocoding" me --town Freeport

Methods compared on the same scorable addresses:
  M0  today's TIGER interpolation (the baseline to beat)
  M1  M0 snapped to the nearest same-side building
  M2  rank order along the side of the street
  M3  M2 without likely outbuildings
  ML  LightGBM lambdarank over the candidate buildings (dataset.FEATURES)
  ML+order  ML's probabilities, assigned one-to-one in increasing number
            order along the road per street and parity (order.py)

Single-town honesty: the model is cross-validated with folds grouped by
STREET (GroupKFold), so every ML prediction comes from a model that never
saw that street -- neighbors on one street are near-copies of each other,
and a random split would let the model memorize them. Training on many
towns and testing on held-out towns is the next step (design doc,
Phase 2-3); this is the Freeport proof.
"""

import argparse
from collections import defaultdict
import os
from datetime import date

import lightgbm as lgb
import numpy as np
import pandas as pd
import psycopg
from sklearn.model_selection import GroupKFold

from . import cross_side, dataset, extensions, loners, order, rate_spots, sites
from .regions import load_region

N_FOLDS = 5
TIERS = (25, 50, 150)
MODEL_PARAMS = dict(
    objective="lambdarank", n_estimators=300, learning_rate=0.05, num_leaves=31,
    min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
    random_state=0, verbose=-1,
)


def _fit(train, features):
    # Addresses whose true building isn't a candidate teach nothing.
    has_positive = train.groupby("address_id")["label"].transform("max") == 1
    train = train[has_positive]
    model = lgb.LGBMRanker(**MODEL_PARAMS)
    model.fit(train[features].astype(float), train["label"],
              group=train.groupby("address_id", sort=False).size().to_numpy())
    return model


def _top1(df, scores) -> int:
    """Addresses whose highest-scored candidate is the true building."""
    d = df.assign(_s=scores)
    best = d.loc[d.groupby("address_id")["_s"].idxmax()]
    return int(best["label"].sum())


INNER_FOLDS = 3
SITES_FOUND: list = []  # last evaluate's sites (sites.site_picks)
CROSS_FOUND: dict = {}  # last evaluate's across-the-road numbers (cross_side.apply)
EXT_FOUND: list = []  # last evaluate's extension streets (extensions.ext_picks)
LAST_CHOICES: list = []  # per outer fold: True = optional features kept


def cross_validated_scores(candidate_df, features=None, optional=None, train_df=None):
    """candidate_df plus an out-of-fold ranker `score` per row, and the
    per-feature importance (gain) summed over folds.
    optional: extra features each outer fold keeps only if they win on its own
    training streets (inner GroupKFold, top-1 right building) -- the test streets
    never take part in the choice."""
    features = list(dataset.FEATURES if features is None else features)
    optional = list(optional or [])
    every = features + optional
    # A total order (source_id breaks ties): the database returns rows in
    # no fixed order, and LightGBM's bagging depends on row order -- without
    # this, the same data gave results that differed run to run.
    df = candidate_df.sort_values(["address_id", "d_m0", "source_id"], kind="stable").reset_index(drop=True)
    X = df[every].astype(float)
    df["score"] = np.nan
    importance = pd.Series(0.0, index=every)
    LAST_CHOICES.clear()
    # train_df: the rows each fold trains on (default: candidate_df itself). evaluate.CONTINUE_SCORE_ONLY trains on
    # the candidates without TIGER continuation pieces and scores the ones with them, fold by street as usual.
    tdf = None if train_df is None else train_df.sort_values(
        ["address_id", "d_m0", "source_id"], kind="stable").reset_index(drop=True)
    if tdf is None:
        folds = list(GroupKFold(n_splits=N_FOLDS).split(X, df["label"], groups=df["street"]))
    else:
        # folds come from the training rows (GroupKFold deals streets by row count, so extra scoring rows would
        # re-deal every fold); each fold scores the rows of its test streets
        folds = []
        for tr, te in GroupKFold(n_splits=N_FOLDS).split(tdf, tdf["label"], groups=tdf["street"]):
            test_streets = set(tdf.iloc[te]["street"])
            folds.append((tr, np.flatnonzero(df["street"].isin(test_streets).to_numpy())))
        missing = ~df["street"].isin(set(tdf["street"]))
        if missing.any():  # a street with rows only when the continuations are in: score it with the last fold
            last_tr, last_te = folds[-1]
            folds[-1] = (last_tr, np.union1d(last_te, np.flatnonzero(missing.to_numpy())))
    for train_idx, test_idx in folds:
        train = df.iloc[train_idx] if tdf is None else tdf.iloc[train_idx]
        use = features
        if optional:
            wins = {False: 0, True: 0}
            inner = GroupKFold(n_splits=INNER_FOLDS).split(train, train["label"], groups=train["street"])
            for in_tr, in_te in inner:
                tr, te = train.iloc[in_tr], train.iloc[in_te]
                for keep in (False, True):
                    cols = every if keep else features
                    wins[keep] += _top1(te, _fit(tr, cols).predict(te[cols].astype(float)))
            keep = wins[True] > wins[False]
            LAST_CHOICES.append(keep)
            use = every if keep else features
        model = _fit(train, use)
        importance[use] += model.booster_.feature_importance("gain")
        df.loc[test_idx, "score"] = model.predict(X.iloc[test_idx][use])
    return df, importance.sort_values(ascending=False)


def top_picks(scored_df) -> dict:
    best = scored_df.loc[scored_df.groupby("address_id")["score"].idxmax()]
    return dict(zip(best["address_id"], best["source_id"]))


def cross_validated_picks(candidate_df):
    """{address_id: source_id} from out-of-fold ranker scores, plus the
    per-feature importance (gain) summed over folds."""
    scored, importance = cross_validated_scores(candidate_df)
    return top_picks(scored), importance


def _coords(candidate_df, extra_coords=None):
    """{source_id: (lat, lon)}: the candidates', plus buildings picked from
    outside the candidate set (order.ASSESSOR_ANY_BUILDING)."""
    out = dict(extra_coords or {})
    df = candidate_df.drop_duplicates("source_id")
    out.update(zip(df["source_id"], zip(df["lat"], df["lon"])))
    return out


def score_method(address_df, candidate_df, picks, property_of=None, extra_coords=None):
    """Error (m), right-building and right-property flags per scorable
    address. An address with no pick (no candidate buildings) falls back to
    its M0 point. Right property: the pick is the E911 building or another
    building of the same small group (order.load_properties) -- a house's
    barn or garage."""
    prop = (lambda b: property_of.get(b, b)) if property_of else (lambda b: b)
    coords = _coords(candidate_df, extra_coords)
    rows = []
    for a in address_df[address_df["scorable"]].itertuples():
        pick = picks.get(a.id) if picks is not None else None
        lat, lon = coords[pick] if pick is not None else (a.m0_lat, a.m0_lon)
        rows.append({
            "street": a.street, "number": a.number,
            "error_m": float(dataset.haversine_m(a.true_lat, a.true_lon, lat, lon)),
            "right_building": pick is not None and pick == a.true_building,
            "right_property": pick is not None and isinstance(a.true_building, str)
                              and prop(pick) == prop(a.true_building),
            "has_true_building": isinstance(a.true_building, str),
        })
    return pd.DataFrame(rows)


def _weights(df):
    """1 / points sharing the address's street + number: every street number
    counts once. 141 Main Street has 563 E911 points on one building -- 11%
    of Freeport's points; counted per point, whether road order happened to
    pick that one building swung the town-wide score by ~11 points."""
    return 1.0 / df.groupby(["street", "number"])["error_m"].transform("size")


def _wmean(values, weights):
    return float(np.average(values, weights=weights)) if len(values) else np.nan


def _wquantile(values, weights, q):
    order_ = np.argsort(values.to_numpy())
    v, w = values.to_numpy()[order_], weights.to_numpy()[order_]
    return float(v[np.searchsorted(np.cumsum(w) / w.sum(), q)])


def summarize(name, scored):
    """Every street number counts once (see _weights); "right building
    (per point)" is the old unweighted figure, for comparison."""
    w = _weights(scored)
    errors = scored["error_m"]
    with_truth = scored[scored["has_true_building"]]
    wt = w[scored["has_true_building"]]
    return {
        "method": name,
        "n": len(scored),
        "numbers": int(scored.groupby(["street", "number"]).ngroups),
        **{f"<= {t} m": _wmean(errors <= t, w) for t in TIERS},
        "median m": _wquantile(errors, w, 0.5),
        "p90 m": _wquantile(errors, w, 0.9),
        "right building": _wmean(with_truth["right_building"], wt),
        "right property": _wmean(with_truth["right_property"], wt),
        "right building (per point)": with_truth["right_building"].mean() if len(with_truth) else np.nan,
    }


# One row per scorable training address: the E911 point, its true building
# (label), and what the cross-validated ranker picked -- what the owner
# dashboard's "Training data" tab maps (GET /admin/address-inference/review).
CREATE_PREDICTIONS_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.ml_predictions (
    region_id TEXT NOT NULL,
    town TEXT NOT NULL,
    method TEXT NOT NULL,
    address_id TEXT NOT NULL,
    address_number INTEGER NOT NULL,
    street TEXT NOT NULL,
    e911_lat DOUBLE PRECISION NOT NULL,
    e911_lon DOUBLE PRECISION NOT NULL,
    m0_lat DOUBLE PRECISION NOT NULL,
    m0_lon DOUBLE PRECISION NOT NULL,
    true_building TEXT,
    picked_building TEXT,
    picked_lat DOUBLE PRECISION,
    picked_lon DOUBLE PRECISION,
    error_m DOUBLE PRECISION NOT NULL,
    status TEXT NOT NULL,
    candidates INTEGER NOT NULL,
    run_date DATE NOT NULL,
    -- assessor methods only: the tax roll pinned this number to a lot with
    -- a candidate building (else it fell back to ML + road order). NULL for
    -- every other method.
    tax_roll BOOLEAN,
    PRIMARY KEY (region_id, town, method, address_id)
)
"""

# Saved methods: the ranker alone, and the ranker + road order (order.py).
SAVED_METHODS = {"ML": "ml", "ML+order": "ml_order", "assessor": "assessor"}

STATUSES = ("right", "wrong", "missed", "no_building")


def prediction_status(true_building, pick, true_in_candidates):
    """right: picked the E911 building. wrong: picked another building
    although the true one was a candidate. missed: the true building was
    never a candidate (no ranker could pick it). no_building: no footprint
    within TRUE_BUILDING_RADIUS_M of the E911 point, so there's no label."""
    if not isinstance(true_building, str):
        return "no_building"
    if pick == true_building:
        return "right"
    return "wrong" if true_in_candidates else "missed"


def prediction_rows(region_id, town, method, address_df, candidate_df, picks, run_date, tax_roll=None,
                    extra_coords=None):
    """tax_roll: the address ids the tax roll pinned (assessor methods), else None."""
    coords = _coords(candidate_df, extra_coords)
    counts = candidate_df.groupby("address_id").size()
    in_candidates = set(candidate_df.loc[candidate_df["label"] == 1, "address_id"])
    rows = []
    for a in address_df[address_df["scorable"]].itertuples():
        pick = picks.get(a.id)
        lat, lon = coords[pick] if pick is not None else (a.m0_lat, a.m0_lon)
        true_building = a.true_building if isinstance(a.true_building, str) else None
        rows.append((
            region_id, town, method, a.id, int(a.number), a.street, float(a.true_lat), float(a.true_lon),
            float(a.m0_lat), float(a.m0_lon), true_building, pick,
            float(lat) if pick is not None else None, float(lon) if pick is not None else None,
            float(dataset.haversine_m(a.true_lat, a.true_lon, lat, lon)),
            prediction_status(true_building, pick, a.id in in_candidates),
            int(counts.get(a.id, 0)), run_date,
            (a.id in tax_roll) if tax_roll is not None else None,
        ))
    return rows


def save_predictions(dsn, region_id, town, rows, methods):
    """Replaces this town's rows for `methods`: one run per town and method."""
    with psycopg.connect(dsn) as conn:
        # Derived data: a table from before the `method` column is just rebuilt.
        has_method = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_schema = 'address_inference' "
            "AND table_name = 'ml_predictions' AND column_name = 'method'").fetchone()
        if not has_method:
            conn.execute("DROP TABLE IF EXISTS address_inference.ml_predictions")
        conn.execute(CREATE_PREDICTIONS_SQL)
        conn.execute("ALTER TABLE address_inference.ml_predictions ADD COLUMN IF NOT EXISTS tax_roll BOOLEAN")
        conn.execute("DELETE FROM address_inference.ml_predictions WHERE region_id = %s AND town = %s "
                     "AND method = ANY(%s)", (region_id, town, methods))
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO address_inference.ml_predictions VALUES "
                "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                rows,
            )


# Owner: "if you're not sure how to assign a building with a street number,
# don't randomly do it -- leave it in another list for me to review." Method
# ml_order_review = ML + road order, except numbers road order itself couldn't
# place (they only had the ranker's guess) are status 'review', no building, with
# a review_list row holding the guess.
def save_review(dsn, region_id, town, address_df, candidate_df, picks, placed, extra_coords=None, far=frozenset()):
    rows = prediction_rows(region_id, town, "ml_order_review", address_df, candidate_df, picks, date.today(),
                           extra_coords=extra_coords)
    out, review = [], []
    for r in rows:
        address_id, number, street, pick = r[3], r[4], r[5], r[11]
        if address_id in placed and address_id not in far:
            out.append(r)
            continue
        reason = ("far from where its street's numbering puts it" if address_id in placed
                  else "road order could not place it (only the ranker's guess)")
        r = list(r)
        r[11], r[12], r[13], r[15] = None, None, None, "review"
        out.append(tuple(r))
        review.append((town, street, number, "ml_order_review", reason, pick))
    save_predictions(dsn, region_id, town, out, ["ml_order_review"])
    with psycopg.connect(dsn) as conn:
        conn.execute("DELETE FROM address_inference.review_list WHERE town = %s AND method = 'ml_order_review'", (town,))
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO address_inference.review_list (town, street, address_number, method, reason, guess_building) "
                "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING", review)


# TIGER pieces named without their type word that continue a street past its dead end (street_match
# CONTINUE_BASE_NAME, High Head Road's 78009083 "High Head"): with CONTINUE_SCORE_ONLY they're added to the
# street's pieces for this run only -- candidates, positions and road order see them -- while the ranker trains
# on the candidates without them, so no other street's training data changes. False = off.
CONTINUE_SCORE_ONLY = False
LAST_CONTINUATIONS: list = []


# Candidates per address: the M0_KEEP nearest TIGER's interpolated spot (as before) plus the RATE_KEEP nearest the
# road-start spot (rate_spots, which doesn't use TIGER's range), out of dataset.MAX_CANDIDATES built. A flat cap of
# 100 nearest M0: Topsham +94.6 (placeholder ranges: Birch Ridge 1-99 vs real 1-16 pushed true houses out of the
# 50), but Freeport -33, Harpswell -16 (good ranges, more far-off confusers). (m0_keep, rate_keep) or None = off.
CAP_M0_KEEP = None  # both set = on
CAP_RATE_KEEP = None


# Road-start candidates only where TIGER's range overshoots the street side's real numbers (placeholder ranges:
# Topsham's Birch Ridge 1-99 for 1-16). Where TIGER tracks the numbers, its spot is the better guide (Gray's
# Mayberry Road: real house 47 m from TIGER's spot, 134 m from the road-start spot) and the extra candidates only
# distract (mixed cap without this: New Gloucester -15, Gray -10.4). None = every address.
CAP_RATE_MIN_INFLATION = None


def cap_mix(candidate_df, m0_keep, rate_keep, eligible=None):
    df = candidate_df
    r_m0 = df.groupby("address_id")["d_m0"].rank(method="first")
    r_rate = df.groupby("address_id")["d_rate_len"].rank(method="first", na_option="bottom")
    rate_ok = r_rate <= rate_keep
    if eligible is not None:
        rate_ok &= df["address_id"].isin(eligible)
    return df[(r_m0 <= m0_keep) | rate_ok].reset_index(drop=True)


def _train_rows(dsn, region, town, ranges):
    """The candidate rows (with rate features) as they are without the continuation pieces."""
    address_df, candidate_df = dataset.build(*dataset.load(dsn, region, town), ranges=ranges)
    if rate_spots.RATE_SPOTS:
        spots = rate_spots.street_spots(dsn, region, town, address_df)
        candidate_df = rate_spots.add_rate_features(candidate_df, address_df, spots,
                                                    order.load_positions(dsn, region, town))
    return candidate_df


def evaluate(dsn, region, town, save=False, ranges="tiger"):
    if not CONTINUE_SCORE_ONLY:
        return _evaluate(dsn, region, town, save, ranges)
    from . import street_match
    with psycopg.connect(dsn) as conn:
        rows = street_match.continuation_rows(conn, town, region.state_abbr)
    LAST_CONTINUATIONS[:] = rows
    if not rows:
        return _evaluate(dsn, region, town, save, ranges)
    train_df = _train_rows(dsn, region, town, ranges)
    key = {"region": region.id, "town": town}
    with psycopg.connect(dsn) as conn:
        conn.execute("""DELETE FROM address_inference.street_match_segments
                        WHERE region_id = %(region)s AND town = %(town)s AND tlid = ANY(%(tlids)s)""",
                     {**key, "tlids": [t for _, t in rows]})
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO address_inference.street_match_segments VALUES (%s, %s, %s, %s)",
                            [(region.id, town, street, t) for street, t in rows])
    try:
        return _evaluate(dsn, region, town, save, ranges, train_df=train_df)
    finally:
        with psycopg.connect(dsn) as conn:
            conn.execute("""DELETE FROM address_inference.street_match_segments
                            WHERE region_id = %(region)s AND town = %(town)s
                              AND (label_street, tlid) IN (SELECT * FROM unnest(%(streets)s::text[], %(tlids)s::text[]))""",
                         {**key, "streets": [st for st, _ in rows], "tlids": [t for _, t in rows]})


def _evaluate(dsn, region, town, save=False, ranges="tiger", train_df=None):
    loaded = dataset.load(dsn, region, town)
    parcels = loaded[3]
    address_df, candidate_df = dataset.build(*loaded, ranges=ranges)
    scorable = address_df[address_df["scorable"]]
    with_truth = scorable["true_building"].notna()
    in_candidates = set(candidate_df.loc[candidate_df["label"] == 1, "address_id"])

    picks = dataset.baseline_picks(candidate_df)
    features = list(dataset.FEATURES)
    if dataset.RELIABILITY:
        rel = dataset.reliability_features(address_df, dataset.reliability_segments(loaded[1]))
        cols = list(zip(*[rel.get(a, (np.nan, np.nan, np.nan)) for a in candidate_df["address_id"]]))
        candidate_df = candidate_df.assign(**{c: list(v) for c, v in zip(dataset.RELIABILITY_COLS, cols)})
        features += dataset.RELIABILITY_COLS
    if rate_spots.RATE_SPOTS:
        # The addresser's own measure: distance from the road's start (rate_spots.py).
        spots = rate_spots.street_spots(dsn, region, town, address_df)
        order._SPOTS.clear()
        order._SPOTS.update(spots)
        candidate_df = rate_spots.add_rate_features(candidate_df, address_df, spots,
                                                    order.load_positions(dsn, region, town))
        extra = rate_spots.RATE_COLS + (["street_rate_m"] if rate_spots.WITH_STREET_RATE else [])
        extra += (["d_rate_local"] if rate_spots.WITH_LOCAL_RATE else []) + (["d_rate_lots"] if rate_spots.WITH_LOT_RATE else [])
        if CAP_M0_KEEP is not None and CAP_RATE_KEEP is not None:
            eligible = None
            if CAP_RATE_MIN_INFLATION is not None:
                rel = dataset.reliability_features(address_df, dataset.reliability_segments(loaded[1]))
                eligible = {a for a, (infl, _u, _c) in rel.items() if infl == infl and infl >= CAP_RATE_MIN_INFLATION}
            candidate_df = cap_mix(candidate_df, CAP_M0_KEEP, CAP_RATE_KEEP, eligible)
    else:
        extra = []
    if rate_spots.RATE_SPOTS == "auto":
        # each fold decides from its own training streets (Freeport's village
        # streets lost 21 numbers with them, rural towns gained up to 184)
        scored, importance = cross_validated_scores(candidate_df, features, optional=extra, train_df=train_df)
    else:
        scored, importance = cross_validated_scores(candidate_df, features + extra, train_df=train_df)
    picks["ML"] = top_picks(scored)
    # Isolated buildings (loners.py): their own street's, and one number each.
    loner_ids, owner_streets = set(), {}
    if loners.LONER_STREET or loners.LONER_ONE:
        iso = order.load_isolation(dsn, town)
        loner_ids = {sid for sid, d in iso.items() if d is not None and d >= loners.LONER_M}
        owner_streets = loners.access_streets(scored, address_df, loner_ids, loners.load_access(dsn, loner_ids))
        if loners.LONER_STREET:
            scored = loners.street_filter(scored, address_df, owner_streets)
    # Road order's own side judgment (dataset.ORDER_SIDE_REAL_FACTOR): after scoring, so nothing retrains.
    if dataset.ORDER_SIDE_REAL_FACTOR is not None and "same_side_order" in scored.columns:
        scored = scored.assign(same_side=scored["same_side_order"])
    # Around a cul-de-sac either side (dataset.CUL_DE_SAC_M): after scoring, so nothing retrains.
    if dataset.CUL_DE_SAC_M is not None and "end_dist_m" in scored.columns:
        near_end = (scored["end_dist_m"] <= dataset.CUL_DE_SAC_M).fillna(False)
        if dataset.CUL_DE_SAC_SKIP_COASTAL:
            # owner: a road running out to the shore (Maquoit Drive) is no cul-de-sac
            from .street_lines import street_lines
            with psycopg.connect(dsn) as conn:
                params = {"region": region.id, "town": town, "state_fips": region.state_fips}
                street_lines(conn, params)
                coastal = order.coastal_dead_ends(conn, params)
            street_of = dict(zip(address_df["id"], address_df["street"]))
            near_end &= ~scored["address_id"].map(street_of).isin(coastal)
        if dataset.CUL_DE_SAC_PARITY_CHECK and near_end.any():
            # a house at the end switches to a parity only if the ranker likes that parity at least as much as the
            # other for it (Gray, Partridge Lane: 15's house stays odd; Todd Brook: 55's house, "even" by geometry, odd)
            num_of = dict(zip(address_df["id"], address_df["number"]))
            st_of = dict(zip(address_df["id"], address_df["street"]))
            par = scored["address_id"].map(num_of).astype(int) % 2
            pr = pd.DataFrame({"st": scored["address_id"].map(st_of), "b": scored["source_id"], "par": par,
                               "p": order.probabilities(scored)})
            best = pr.groupby(["st", "b", "par"])["p"].max().to_dict()
            # a switch to the other side needs CUL_DE_SAC_PARITY_RATIO x the house's own side's best (Partridge Lane:
            # 20 at 0.149 vs 15 at 0.140 is no evidence 15's end house is even)
            ok = [best.get((st, b, pa), 0.0) >= (dataset.CUL_DE_SAC_PARITY_RATIO if not s0 else 1.0) * best.get((st, b, 1 - pa), 0.0)
                  for st, b, pa, s0 in zip(pr["st"], pr["b"], pr["par"], scored["same_side"].astype(bool))]
            near_end &= np.array(ok, dtype=bool)
        if dataset.CUL_DE_SAC_SHORT_CHECK and near_end.any():
            # an end house only crosses to a side that is short of houses: more numbers than distinct own-side top
            # picks (Gray, Alling Drive: evens 2-20 already have their 6 houses, so 20 can't take 13's end house)
            num_of = dict(zip(address_df["id"], address_df["number"]))
            st_of = dict(zip(address_df["id"], address_df["street"]))
            own_mask = scored["same_side"].astype(bool).to_numpy()
            own = scored[own_mask].assign(_p=order.probabilities(scored)[own_mask])
            top = own.sort_values(["address_id", "_p", "source_id"], ascending=[True, False, True]).drop_duplicates("address_id")
            key = list(zip(address_df["street"], address_df["number"].astype(int) % 2))
            n_numbers = pd.Series(1, index=pd.MultiIndex.from_tuples(key)).groupby(level=[0, 1]).sum().to_dict()
            tk = list(zip(top["address_id"].map(st_of), top["address_id"].map(num_of).astype(int) % 2))
            n_houses = pd.DataFrame({"k": tk, "b": top["source_id"].to_numpy()}).groupby("k")["b"].nunique().to_dict()
            rk = list(zip(scored["address_id"].map(st_of), scored["address_id"].map(num_of).astype(int) % 2))
            if dataset.CUL_DE_SAC_SHORT_CHECK == "count":
                # houses a side seriously considers (own-side p >= CUL_DE_SAC_HOUSE_P), not top picks, which collide
                # (Miles Way's 22 has no house of its own; Norton Farm's odds share a top pick): the giving side must
                # keep one house per number after losing this one (Alling: odds 5 houses for 5 numbers keep 13's)
                considered = own[own["_p"] >= dataset.CUL_DE_SAC_HOUSE_P]
                ck = list(zip(considered["address_id"].map(st_of), considered["address_id"].map(num_of).astype(int) % 2))
                n_cand = pd.DataFrame({"k": ck, "b": considered["source_id"].to_numpy()}).groupby("k")["b"].nunique().to_dict()
                # a side with no numbers is never short (Breezy Acres: evens only, its end house can cross)
                giver_tight = np.array([0 < n_numbers.get((st, 1 - pa), 0) >= n_cand.get((st, 1 - pa), 0) for st, pa in rk], dtype=bool)
                near_end &= ~(~scored["same_side"].astype(bool) & giver_tight)
            elif dataset.CUL_DE_SAC_SHORT_CHECK == "giver":
                # the house's own side (the other parity) must not already be short: taking from it makes it slide
                # (Alling: odds 5 numbers on 4 distinct picks keep 13's house; Miles Way: 22 alone gives fb9b to 11)
                giver_short = np.array([n_numbers.get((st, 1 - pa), 0) > n_houses.get((st, 1 - pa), 0) for st, pa in rk], dtype=bool)
                near_end &= ~(~scored["same_side"].astype(bool) & giver_short)
            else:
                short = np.array([n_numbers.get(k, 0) > n_houses.get(k, 0) for k in rk], dtype=bool)
                near_end &= ~(~scored["same_side"].astype(bool) & ~short)
        scored = scored.assign(same_side=scored["same_side"].astype(bool) | near_end)
    if dataset.CUL_DE_SAC_ENTRY_M is not None:
        from .street_names import canonical
        with psycopg.connect(dsn) as conn:
            ends = {(sid, canonical(road)) for sid, road in conn.execute(
                dataset.CUL_DE_SAC_ENTRY_SQL, {"town": town, "m": float(dataset.CUL_DE_SAC_ENTRY_M), "min_piece": float(dataset.CUL_DE_SAC_MIN_PIECE_M), "near": float(dataset.CUL_DE_SAC_NEAR_M)})}
        if ends:
            street_of = {a: canonical(st) for a, st in zip(address_df["id"], address_df["street"])}
            at_end = [(b, street_of.get(a)) in ends for a, b in zip(scored["address_id"], scored["source_id"])]
            scored = scored.assign(same_side=scored["same_side"].astype(bool) | np.array(at_end, dtype=bool))
    if dataset.LOOP_ENTRY_SIDE:
        with psycopg.connect(dsn) as conn:
            entries = conn.execute(dataset.LOOP_ENTRY_SQL, {"region": region.id, "town": town}).fetchall()
            seg_of = {str(sg[1]): sg for sg in loaded[1]}
            side_par = {}  # (street, source_id) -> parity of its side
            for loop_tlid, entry_tlid, starts_at_loop, _e, _l, street in entries:
                loop = seg_of.get(str(loop_tlid))
                if loop is None:
                    continue
                lf, rf = dataset._int_or_none(loop[2]), dataset._int_or_none(loop[4])
                left_par = lf % 2 if lf is not None else (1 - rf % 2 if rf is not None else None)
                if left_par is None:
                    continue
                for sid, side in conn.execute("SELECT source_id, side FROM address_inference.building_segments "
                                              "WHERE tlid = %s AND NOT at_end", (str(entry_tlid),)).fetchall():
                    travel_left = (side == "R") if starts_at_loop else (side == "L")
                    side_par[(street, sid)] = left_par if travel_left else 1 - left_par
        if side_par:
            st_of = dict(zip(address_df["id"], address_df["street"]))
            num_of = dict(zip(address_df["id"], address_df["number"]))
            par = [side_par.get((st_of.get(a), b)) for a, b in zip(scored["address_id"], scored["source_id"])]
            new_same = [s0 if p is None else int(num_of[a]) % 2 == p
                        for a, p, s0 in zip(scored["address_id"], par, scored["same_side"].astype(bool))]
            scored = scored.assign(same_side=np.array(new_same, dtype=bool))
    order._CUL_POS.clear()
    if order.CUL_LOTS_M is not None:
        # lots around a dead end: their houses count for either side (and take the lot's place, load_positions)
        order._CUL_POS.update(order.load_cul_de_sacs(dsn, region, town))
        on_lot = [(st, b) in order._CUL_POS for st, b in zip(scored["address_id"].map(dict(zip(address_df["id"], address_df["street"]))), scored["source_id"])]
        scored = scored.assign(same_side=scored["same_side"].astype(bool) | np.array(on_lot, dtype=bool))
    # The building at a number's road-start spot counts more in road order (rate_spots.RATE_BONUS).
    scored = rate_spots.rate_rescore(scored)
    # Numbers the addresser put across the road (cross_side.py).
    scored, CROSS_FOUND_LAST = cross_side.apply(scored, address_df)
    CROSS_FOUND.clear()
    CROSS_FOUND.update(CROSS_FOUND_LAST)
    ml_fallback = (top_picks(scored) if (loners.LONER_STREET or CROSS_FOUND_LAST) else picks["ML"])
    # Main roads first: a building a more important street confidently takes
    # is off limits to the streets after it (order.CLAIM_MIN_P).
    street_order = order.street_priority(address_df, order.load_street_classes(dsn, region, town))
    positions = order.load_positions(dsn, region, town)
    side_dirs = order.load_side_directions(dsn, region, town) if order.SIDE_DIRECTIONS else None
    order.set_guard_town(dsn, town)
    if order.EMPTY_LOT_PLACES:
        # empty house-sized lots are places too (a house hidden by trees): each joins its side's numbers' candidates
        # as the weakest one, at its frontage; a number placed there is dropped (unplaced) after road order
        places = order.empty_lot_places(dsn, region, town, loaded[1])
        if places:
            num_of = dict(zip(address_df["id"], address_df["number"]))
            st_of = dict(zip(address_df["id"], address_df["street"]))
            own = scored[scored["same_side"].astype(bool)]
            weakest = own.sort_values(["address_id", "score", "source_id"]).drop_duplicates("address_id").set_index("address_id")
            if order.EMPTY_LOT_SCORE == "median":
                weakest = weakest.assign(score=own.groupby("address_id")["score"].median().reindex(weakest.index))
            by_side = defaultdict(list)
            for street, pid, along, lat, lon, par in places:
                by_side[(street, par)].append((pid, lat, lon))
                positions[(street, pid)] = along
            extra = []
            for aid, tmpl in weakest.iterrows():
                for pid, lat, lon in by_side.get((st_of.get(aid), int(num_of[aid]) % 2), []):
                    row = tmpl.copy()
                    row["source_id"], row["lat"], row["lon"], row["same_side"] = pid, lat, lon, True
                    if "dist_vs_nearest_road" in row.index:
                        row["dist_vs_nearest_road"] = 0.0
                    extra.append(row.rename(None).to_dict() | {"address_id": aid})
            if extra:
                scored = pd.concat([scored, pd.DataFrame(extra)], ignore_index=True)
    if parcels:
        # Each ordinary multi-building tax lot is one place along the road.
        parcel_of = {sid: info["parcel"] for sid, info in parcels["buildings"].items()}
        lot_addresses = order.load_lot_addresses(dsn, region, town)
        known_streets = None
        if order.OTHER_STREET_REAL_NAMES or order.OTHER_STREET_FUZZY is not None:  # TIGER's names + the address list's own street names (US ROUTE ONE = US Hwy 1)
            from .street_names import canonical
            known_streets = order.load_town_streets(dsn, town) | {canonical(s) for s in address_df["street"].unique()}
        # Only the tax roll's street names (order.OTHER_STREET_LOTS), never its numbers.
        fallback = (order.allowed_top_picks(scored, address_df, parcel_of, order.lot_streets(lot_addresses, known_streets))
                    if order.FALLBACK_LOT_RULE else ml_fallback)
        lot_kwargs = dict(street_order=street_order, roof_of=order.load_roofs(dsn),
                          streets_of_lot=order.lot_streets(lot_addresses, known_streets),
                          fronts_of_lot=order.load_lot_fronts(dsn, town, order.LOT_FRONTS)
                          if order.LOT_FRONTS else None, side_directions=side_dirs)
        picks["ML+order"] = order.lot_picks(address_df, scored, positions, fallback, parcel_of, **lot_kwargs)
        # Second pass: each side's own number-by-distance line (order.LINE_BONUS).
        rescored = order.line_rescore(address_df, scored, positions, picks["ML+order"], set(order.LAST_PLACED))
        if rescored is not None:
            picks["ML+order"] = order.lot_picks(address_df, rescored, positions, fallback, parcel_of, **lot_kwargs)
        # Third pass: spots interpolated between the numbers already placed where
        # the addresser's rate says (order.ANCHOR_BONUS).
        anchored = order.anchor_rescore(address_df, scored, positions, picks["ML+order"], set(order.LAST_PLACED))
        if anchored is not None:
            picks["ML+order"] = order.lot_picks(address_df, anchored, positions, fallback, parcel_of, **lot_kwargs)
    else:
        picks["ML+order"] = order.order_constrained_picks(address_df, scored, positions, ml_fallback,
                                                          street_order=street_order, side_directions=side_dirs)
    if parcels:
        # Owner's two-houses-one-lot rule (order.LOT_PAIR_FILL).
        size_of = {sid: s for sid, s in zip(candidate_df["source_id"], candidate_df["sqmeters"])}
        picks["ML+order"] = order.lot_pair_fill(dsn, region, town, address_df, picks["ML+order"],
                                                set(order.LAST_PLACED), parcel_of, size_of)
    placed_by_order = set(order.LAST_PLACED) if parcels else None
    # Owner's options + spacing check (order.SPACING_WEIGHT).
    if placed_by_order is not None:
        picks["ML+order"] = order.spacing_options(address_df, scored, positions, picks["ML+order"], placed_by_order)
        picks["ML+order"] = order.run_shift_options(address_df, scored, positions, picks["ML+order"], placed_by_order)
        picks["ML+order"] = order.drop_one_options(address_df, scored, positions, picks["ML+order"],
                                                   placed_by_order, ml_fallback)
        placed_by_order -= order.LAST_DROPPED
    # Owner's short-end-branch rule (order.END_BRANCH_MAX_M).
    picks["ML+order"] = order.end_branch_picks(dsn, region, town, address_df, positions, picks["ML+order"],
                                               parcel_of if parcels else None, side_dirs)
    # Campus / institutional sites are numbered as one set (sites.py).
    picks["ML+order"], SITES_FOUND[:] = sites.site_picks(dsn, region, town, address_df, picks["ML+order"],
                                                        dict(order._SPOTS) if rate_spots.RATE_SPOTS else {})
    # Extension streets that borrow their parent's line start where the parent ends (extensions.py).
    sheds = {b for b, r in order._NEAR_BIGGEST.items() if order.ACCESSORY_MAX_RATIO and r < order.ACCESSORY_MAX_RATIO}
    picks["ML+order"], EXT_FOUND[:] = extensions.ext_picks(dsn, region, town, address_df, picks["ML+order"],
                                                          positions, skip=sheds)
    if loners.LONER_ONE:
        picks["ML+order"] = loners.one_number(picks["ML+order"], scored, address_df, loner_ids, owner_streets)
    if order.EMPTY_LOT_PLACES:
        picks["ML+order"] = {a: b for a, b in picks["ML+order"].items() if not str(b).startswith("empty:")}
    assessor_matched = set()
    extra_coords = None
    if parcels:
        # The assessor's own address for each lot, scored on its own (never a
        # model input): the lot's biggest building, else ML + road order.
        size_of = candidate_df.drop_duplicates("source_id").set_index("source_id")["sqmeters"].to_dict()
        if order.ASSESSOR_ANY_BUILDING:
            lot_buildings = order.load_lot_buildings(dsn, region, town)
            extra_coords = {sid: (lat, lon) for sid, (_m2, lat, lon) in lot_buildings.items()}
            size_of = {**{sid: m2 for sid, (m2, _lat, _lon) in lot_buildings.items()}, **size_of}
        lane_neighbors = (order.load_lane_neighbors(dsn, region, lot_addresses)
                          if order.SHIFT_RUN_MIN and order.SHIFT_NEAR_LANE else None)
        picks["assessor"], assessor_matched = order.assessor_picks(
            address_df, lot_addresses, parcel_of, size_of, picks["ML+order"],
            roof_of=order.load_roofs(dsn), positions=positions, scored_df=scored, lane_neighbors=lane_neighbors)

    property_of = order.load_properties(
        dsn, region, set(candidate_df["source_id"]) | set(address_df["true_building"].dropna()))
    # A tax parcel is the real property: buildings on one lot are one
    # property (parcels.py); the 12 m grouping covers buildings without one.
    if parcels:
        property_of.update({sid: "parcel:" + info["parcel"] for sid, info in parcels["buildings"].items()})
    if order.EMPTY_LOT_PLACES:  # a number on an empty lot is unplaced, in every method built from road order
        for name in list(picks):
            if isinstance(picks[name], dict):
                picks[name] = {a: b for a, b in picks[name].items() if not str(b).startswith("empty:")}
    table = [summarize("M0 interpolation (today)", score_method(address_df, candidate_df, None, property_of))]
    for name, label in (("M1", "M1 snap to building"), ("M2", "M2 rank order"),
                        ("M3", "M3 rank order, no outbuildings"), ("ML", "ML ranker (LightGBM)"),
                        ("ML+order", "ML + road order (one-to-one)"),
                        ("assessor", "Assessor's lot address, else ML + road order")):
        if name in picks:
            table.append(summarize(label, score_method(address_df, candidate_df, picks[name], property_of, extra_coords)))
    if assessor_matched:
        # The same comparison on just the addresses the assessor has a lot for.
        on = address_df[address_df["id"].isin(assessor_matched)]
        for name, label in (("ML+order", "  on assessor-matched addresses: ML + road order"),
                            ("assessor", "  on assessor-matched addresses: assessor's lot")):
            table.append(summarize(label, score_method(on, candidate_df, picks[name], property_of, extra_coords)))

    coverage = {
        "E911 addresses on matched streets": len(address_df),
        "scorable (a TIGER range holds the number)": len(scorable),
        "  with a true building within 30 m": int(with_truth.sum()),
        "  true building among the candidates (ceiling for right-building %)": len(in_candidates),
        "candidate rows": len(candidate_df),
        "  scorable with an assessor lot of the same number and street": int(
            address_df["scorable"][address_df["id"].isin(assessor_matched)].sum()),
    }
    if save:
        rows = []
        suffix = "" if ranges == "tiger" else f"_{ranges}"
        saved = {name: method for name, method in SAVED_METHODS.items() if name in picks}
        for name, method in saved.items():
            rows += prediction_rows(region.id, town, method + suffix, address_df, candidate_df, picks[name], date.today(),
                                    tax_roll=assessor_matched if name == "assessor" else None, extra_coords=extra_coords)
        save_predictions(dsn, region.id, town, rows, [m + suffix for m in saved.values()])
        if suffix == "" and "ML+order" in picks and placed_by_order is not None:
            far = order.far_from_line(address_df, positions, picks["ML+order"], placed_by_order)
            save_review(dsn, region.id, town, address_df, candidate_df, picks["ML+order"], placed_by_order, extra_coords, far)
    return pd.DataFrame(table), coverage, importance


def report_markdown(town, table, coverage, importance) -> str:
    fmt = table.copy()
    for col in ("<= 25 m", "<= 50 m", "<= 150 m", "right building", "right property", "right building (per point)"):
        fmt[col] = fmt[col].map(lambda v: "–" if pd.isna(v) else f"{v:.1%}")
    for col in ("median m", "p90 m"):
        fmt[col] = fmt[col].map(lambda v: f"{v:,.0f}")
    fmt.loc[0, "right building"] = "–"
    fmt.loc[0, "right property"] = "–"
    fmt.loc[0, "right building (per point)"] = "–"
    lines = [f"# {town}: building-address methods vs. E911 ({date.today().isoformat()})", ""]
    lines += [f"- {k}: {v:,}" for k, v in coverage.items()]
    header = "| " + " | ".join(fmt.columns) + " |"
    rule = "|" + "---|" * len(fmt.columns)
    body = ["| " + " | ".join(str(v) for v in row) + " |" for row in fmt.itertuples(index=False)]
    lines += ["", header, rule, *body, "", "Top features (gain):", ""]
    lines += [f"- {name}: {gain:,.0f}" for name, gain in importance.head(10).items()]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn")
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("--save", action="store_true",
                        help="keep each address's ML pick in address_inference.ml_predictions "
                             "(mapped by the owner dashboard's Training data tab)")
    parser.add_argument("--ranges", choices=("tiger", "list", "auto"), default="tiger",
                        help="where a number's place along the street comes from: TIGER's address ranges, "
                             "or the list's own min..max per street side (saved as methods *_list)")
    args = parser.parse_args()
    table, coverage, importance = evaluate(args.dsn, load_region(args.region), args.town, save=args.save,
                                           ranges=args.ranges)
    print(report_markdown(args.town, table, coverage, importance))


if __name__ == "__main__":
    main()
