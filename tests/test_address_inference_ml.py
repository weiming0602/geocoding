"""Stages 3-4 of address_inference: dataset building, baselines, ML ranker."""

import numpy as np
import pandas as pd
import pytest

from address_inference import dataset, evaluate

# One street, one west->east segment ~800 m long. Left (north) side holds
# odd numbers 1..99, right side even 2..98.
SEGMENT = ("MAIN STREET", "1", "1", "99", "2", "98", "LINESTRING(-70.105 43.85, -70.095 43.85)", 800.0)


def seg_dict():
    keys = ("label_street", "tlid", "lfromadd", "ltoadd", "rfromadd", "rtoadd", "geometry", "length_m")
    return dict(zip(keys, SEGMENT))


# --- covering_range ----------------------------------------------------------


def test_covering_range_reads_side_and_parity_from_the_segment():
    seg, side, fraction, span = dataset.covering_range(51, [seg_dict()])
    assert (side, span) == ("L", 98) and fraction == pytest.approx(50 / 98)
    assert dataset.covering_range(50, [seg_dict()])[1] == "R"
    assert dataset.covering_range(101, [seg_dict()]) is None


def test_covering_range_handles_descending_ranges_and_prefers_the_tightest():
    wide = {**seg_dict(), "tlid": "w", "lfromadd": "99", "ltoadd": "1", "rfromadd": "", "rtoadd": ""}
    tight = {**seg_dict(), "tlid": "t", "lfromadd": "41", "ltoadd": "61", "rfromadd": "", "rtoadd": ""}
    seg, side, fraction, _ = dataset.covering_range(51, [wide, tight])
    assert seg["tlid"] == "t" and fraction == pytest.approx(0.5)
    _, _, fraction, _ = dataset.covering_range(51, [wide])
    assert fraction == pytest.approx(48 / 98)  # counted from the `from` end (99)


# --- build -------------------------------------------------------------------

# Three houses north of the road (left side) at t = 0.2, 0.5, 0.8, plus a
# small shed just behind the middle one, and one house on the south side.
BUILDINGS = [
    # source_id, side, t, dist_m, sqmeters, lon, lat
    ("h1", "L", 0.2, 20, 150, -70.103, 43.8502),
    ("h2", "L", 0.5, 20, 150, -70.100, 43.8502),
    ("shed", "L", 0.5, 45, 30, -70.100, 43.8504),
    ("h3", "L", 0.8, 20, 150, -70.097, 43.8502),
    ("s1", "R", 0.5, 20, 150, -70.100, 43.8498),
]


def candidate_rows():
    return [
        ("MAIN STREET", sid, "1", side, t, False, dist, sqm, "Residential", "Single Family Dwelling", None,
         lat, lon, "1", dist)
        for sid, side, t, dist, sqm, lon, lat in BUILDINGS
    ]


def build_one(number, true_id, true_lat=43.8502, true_lon=-70.100):
    addresses = [("e1", number, "MAIN STREET", "exact", true_lat, true_lon, true_id)]
    return dataset.build(addresses, [SEGMENT], candidate_rows())


def test_build_computes_m0_candidates_and_label():
    address_df, cand = build_one(51, "h2")
    a = address_df.iloc[0]
    assert a["scorable"] and a["cover_side"] == "L"
    # M0 sits near the middle of the segment, 20 ft north of the centerline.
    assert a["m0_lon"] == pytest.approx(-70.0999, abs=2e-4) and a["m0_lat"] > 43.85
    assert set(cand["source_id"]) == {"h1", "h2", "shed", "h3", "s1"}
    assert cand.set_index("source_id")["label"].to_dict() == {"h1": 0, "h2": 1, "shed": 0, "h3": 0, "s1": 0}
    row = cand.set_index("source_id")
    assert row.at["s1", "same_side"] == False  # noqa: E712 -- numpy bool
    assert row.at["shed", "bigger_in_front"] and not row.at["h2", "bigger_in_front"]
    assert row.at["h2", "numbers_from_start"] == 50


def test_unscorable_address_is_kept_but_has_no_candidates():
    address_df, cand = build_one(501, "h2")
    assert not address_df.iloc[0]["scorable"] and cand.empty


def test_baselines_pick_by_distance_and_by_rank_order():
    # 21 is ~20% of the way along 1..99: M2 (rank order) picks h1; M1 picks
    # whichever same-side building is nearest M0's interpolated point.
    _, cand = build_one(21, "h1", true_lon=-70.103)
    picks = dataset.baseline_picks(cand)
    assert picks["M2"]["e1"] == "h1"
    assert picks["M3"]["e1"] == "h1"
    assert picks["M1"]["e1"] in {"h1", "h2"}


# --- evaluate ----------------------------------------------------------------


def test_score_method_falls_back_to_m0_without_a_pick():
    address_df, cand = build_one(51, "h2")
    scored = evaluate.score_method(address_df, cand, {"e1": "h2"})
    assert scored.iloc[0]["right_building"] and scored.iloc[0]["error_m"] == pytest.approx(0, abs=0.5)
    m0 = evaluate.score_method(address_df, cand, None)
    assert not m0.iloc[0]["right_building"] and m0.iloc[0]["error_m"] > 0


def test_cross_validation_learns_a_learnable_rule():
    """Synthetic: the true building is always the one with the smallest
    rank_gap. Grouped by street, every prediction comes from a model that
    never saw that street; it should still learn the rule."""
    rng = np.random.default_rng(0)
    rows = []
    for a in range(400):
        gaps = rng.random(6)
        for b, gap in enumerate(gaps):
            row = {f: rng.random() for f in dataset.FEATURES}
            row.update(address_id=f"a{a}", street=f"s{a // 4}", source_id=f"a{a}-b{b}", rank_gap=gap,
                       label=int(gap == gaps.min()), d_m0=rng.random())
            rows.append(row)
    picks, importance = evaluate.cross_validated_picks(pd.DataFrame(rows))
    correct = np.mean([picks[f"a{a}"] == min(
        (r for r in rows if r["address_id"] == f"a{a}"), key=lambda r: r["rank_gap"])["source_id"] for a in range(400)])
    assert correct > 0.8  # chance is 1 in 6
    assert importance.index[0] == "rank_gap"
