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
from datetime import date

import lightgbm as lgb
import numpy as np
import pandas as pd
import psycopg
from sklearn.model_selection import GroupKFold

from . import dataset, order
from .regions import load_region

N_FOLDS = 5
TIERS = (25, 50, 150)
MODEL_PARAMS = dict(
    objective="lambdarank", n_estimators=300, learning_rate=0.05, num_leaves=31,
    min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
    random_state=0, verbose=-1,
)


def cross_validated_scores(candidate_df):
    """candidate_df plus an out-of-fold ranker `score` per row, and the
    per-feature importance (gain) summed over folds."""
    # A total order (source_id breaks ties): the database returns rows in
    # no fixed order, and LightGBM's bagging depends on row order -- without
    # this, the same data gave results that differed run to run.
    df = candidate_df.sort_values(["address_id", "d_m0", "source_id"], kind="stable").reset_index(drop=True)
    X = df[dataset.FEATURES].astype(float)
    df["score"] = np.nan
    importance = np.zeros(len(dataset.FEATURES))
    folds = GroupKFold(n_splits=N_FOLDS).split(X, df["label"], groups=df["street"])
    for train_idx, test_idx in folds:
        train = df.iloc[train_idx]
        # Addresses whose true building isn't a candidate teach nothing.
        has_positive = train.groupby("address_id")["label"].transform("max") == 1
        train = train[has_positive]
        model = lgb.LGBMRanker(**MODEL_PARAMS)
        model.fit(train[dataset.FEATURES].astype(float), train["label"],
                  group=train.groupby("address_id", sort=False).size().to_numpy())
        importance += model.booster_.feature_importance("gain")
        df.loc[test_idx, "score"] = model.predict(X.iloc[test_idx])
    return df, pd.Series(importance, index=dataset.FEATURES).sort_values(ascending=False)


def top_picks(scored_df) -> dict:
    best = scored_df.loc[scored_df.groupby("address_id")["score"].idxmax()]
    return dict(zip(best["address_id"], best["source_id"]))


def cross_validated_picks(candidate_df):
    """{address_id: source_id} from out-of-fold ranker scores, plus the
    per-feature importance (gain) summed over folds."""
    scored, importance = cross_validated_scores(candidate_df)
    return top_picks(scored), importance


def score_method(address_df, candidate_df, picks, property_of=None):
    """Error (m), right-building and right-property flags per scorable
    address. An address with no pick (no candidate buildings) falls back to
    its M0 point. Right property: the pick is the E911 building or another
    building of the same small group (order.load_properties) -- a house's
    barn or garage."""
    prop = (lambda b: property_of.get(b, b)) if property_of else (lambda b: b)
    coords = candidate_df.drop_duplicates("source_id").set_index("source_id")[["lat", "lon"]]
    rows = []
    for a in address_df[address_df["scorable"]].itertuples():
        pick = picks.get(a.id) if picks is not None else None
        lat, lon = (coords.at[pick, "lat"], coords.at[pick, "lon"]) if pick is not None else (a.m0_lat, a.m0_lon)
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


def prediction_rows(region_id, town, method, address_df, candidate_df, picks, run_date, tax_roll=None):
    """tax_roll: the address ids the tax roll pinned (assessor methods), else None."""
    coords = candidate_df.drop_duplicates("source_id").set_index("source_id")[["lat", "lon"]]
    counts = candidate_df.groupby("address_id").size()
    in_candidates = set(candidate_df.loc[candidate_df["label"] == 1, "address_id"])
    rows = []
    for a in address_df[address_df["scorable"]].itertuples():
        pick = picks.get(a.id)
        lat, lon = (coords.at[pick, "lat"], coords.at[pick, "lon"]) if pick is not None else (a.m0_lat, a.m0_lon)
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


def evaluate(dsn, region, town, save=False, ranges="tiger"):
    loaded = dataset.load(dsn, region, town)
    parcels = loaded[3]
    address_df, candidate_df = dataset.build(*loaded, ranges=ranges)
    scorable = address_df[address_df["scorable"]]
    with_truth = scorable["true_building"].notna()
    in_candidates = set(candidate_df.loc[candidate_df["label"] == 1, "address_id"])

    picks = dataset.baseline_picks(candidate_df)
    scored, importance = cross_validated_scores(candidate_df)
    picks["ML"] = top_picks(scored)
    # Main roads first: a building a more important street confidently takes
    # is off limits to the streets after it (order.CLAIM_MIN_P).
    street_order = order.street_priority(address_df, order.load_street_classes(dsn, region, town))
    positions = order.load_positions(dsn, region, town)
    if parcels:
        # Each ordinary multi-building tax lot is one place along the road.
        parcel_of = {sid: info["parcel"] for sid, info in parcels["buildings"].items()}
        lot_addresses = order.load_lot_addresses(dsn, region, town)
        # Only the tax roll's street names (order.OTHER_STREET_LOTS), never its numbers.
        picks["ML+order"] = order.lot_picks(address_df, scored, positions, picks["ML"], parcel_of,
                                            street_order=street_order, roof_of=order.load_roofs(dsn),
                                            streets_of_lot=order.lot_streets(lot_addresses))
    else:
        picks["ML+order"] = order.order_constrained_picks(address_df, scored, positions, picks["ML"],
                                                          street_order=street_order)
    assessor_matched = set()
    if parcels:
        # The assessor's own address for each lot, scored on its own (never a
        # model input): the lot's biggest building, else ML + road order.
        size_of = candidate_df.drop_duplicates("source_id").set_index("source_id")["sqmeters"].to_dict()
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
    table = [summarize("M0 interpolation (today)", score_method(address_df, candidate_df, None, property_of))]
    for name, label in (("M1", "M1 snap to building"), ("M2", "M2 rank order"),
                        ("M3", "M3 rank order, no outbuildings"), ("ML", "ML ranker (LightGBM)"),
                        ("ML+order", "ML + road order (one-to-one)"),
                        ("assessor", "Assessor's lot address, else ML + road order")):
        if name in picks:
            table.append(summarize(label, score_method(address_df, candidate_df, picks[name], property_of)))
    if assessor_matched:
        # The same comparison on just the addresses the assessor has a lot for.
        on = address_df[address_df["id"].isin(assessor_matched)]
        for name, label in (("ML+order", "  on assessor-matched addresses: ML + road order"),
                            ("assessor", "  on assessor-matched addresses: assessor's lot")):
            table.append(summarize(label, score_method(on, candidate_df, picks[name], property_of)))

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
                                    tax_roll=assessor_matched if name == "assessor" else None)
        save_predictions(dsn, region.id, town, rows, [m + suffix for m in saved.values()])
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
