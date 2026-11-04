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


# --- saved predictions -------------------------------------------------------


def test_prediction_status_separates_wrong_picks_from_unreachable_ones():
    assert evaluate.prediction_status("h2", "h2", True) == "right"
    assert evaluate.prediction_status("h2", "h1", True) == "wrong"
    assert evaluate.prediction_status("h2", "h1", False) == "missed"
    assert evaluate.prediction_status("h2", None, False) == "missed"
    assert evaluate.prediction_status(None, "h1", False) == "no_building"


def test_prediction_rows_record_the_pick_and_its_error():
    from datetime import date
    address_df, cand = build_one(51, "h2")
    (row,) = evaluate.prediction_rows("me", "Freeport", "ml", address_df, cand, {"e1": "h1"}, date(2026, 11, 3))
    assert row[2:6] == ("ml", "e1", 51, "MAIN STREET")
    assert row[10:12] == ("h2", "h1") and row[15] == "wrong" and row[16] == 5
    assert row[14] == pytest.approx(240, abs=5)  # h1 sits ~0.003 deg west of the E911 point


# --- road order (order.py) ------------------------------------------------------


def test_monotone_assign_keeps_numbers_in_road_order_and_one_per_building():
    from address_inference import order
    # Alone, both numbers would take building 1; in order, 10 -> 0 and 20 -> 1.
    P = np.array([[0.45, 0.55, 0.0],
                  [0.0, 0.9, 0.1]])
    total, match = order.monotone_assign(P)
    assert match == {0: 0, 1: 1} and total == pytest.approx(1.35)


def test_order_constrained_picks_fixes_a_crossed_pair_and_picks_the_direction():
    from address_inference import order
    address_df = pd.DataFrame([
        {"id": "a10", "number": 10, "street": "MAIN", "scorable": True},
        {"id": "a20", "number": 20, "street": "MAIN", "scorable": True},
    ])
    # Road runs b3 -> b2 -> b1 (numbers increase toward b1).
    positions = {("MAIN", "b1"): 300.0, ("MAIN", "b2"): 200.0, ("MAIN", "b3"): 100.0}
    scored = pd.DataFrame([
        ("a10", "b2", 2.0, True), ("a10", "b3", 1.8, True), ("a10", "b1", -5.0, True),
        ("a20", "b2", 2.0, True), ("a20", "b1", 1.0, True), ("a20", "b3", -5.0, True),
        ("a20", "b9", 9.0, False),  # across the road: never taken
    ], columns=["address_id", "source_id", "score", "same_side"])
    positions[("MAIN", "b9")] = 250.0
    picks = order.order_constrained_picks(address_df, scored, positions, {"a10": "b2", "a20": "b2"})
    assert picks in ({"a10": "b3", "a20": "b2"}, {"a10": "b2", "a20": "b1"})


# --- list ranges ---------------------------------------------------------------


def test_list_range_number_uses_the_lists_scale_not_tigers():
    # TIGER says 1..99 on the left; the real odd numbers are 1..9. 9 is the
    # last real house, so it belongs at the far end (TIGER's 99), 5 halfway.
    segs = [seg_dict()]
    nums = [1, 3, 5, 7, 9]
    assert dataset.list_range_number(9, nums, segs) == 99
    assert dataset.list_range_number(1, nums, segs) == 1
    assert dataset.list_range_number(5, nums, segs) == 51  # halfway (50), nearest odd
    # Even side: TIGER 2..98, real 4..10.
    assert dataset.list_range_number(10, [4, 6, 8, 10], segs) == 98
    # One number on the side: no scale, TIGER's own range is used.
    assert dataset.list_range_number(7, [7], segs) == 7


def test_build_with_list_ranges_puts_the_last_house_at_the_end():
    addresses = [("e1", 1, "MAIN STREET", "exact", 43.8502, -70.103, "h1"),
                 ("e9", 9, "MAIN STREET", "exact", 43.8502, -70.097, "h3")]
    tiger, _ = dataset.build(addresses, [SEGMENT], candidate_rows())
    listed, _ = dataset.build(addresses, [SEGMENT], candidate_rows(), ranges="list")
    f = lambda df: df.set_index("id").at["e9", "f"]
    assert f(tiger) == pytest.approx(8 / 98) and f(listed) == pytest.approx(1.0)


def test_auto_ranges_only_override_a_placeholder_range_for_sequential_numbers():
    segs = [seg_dict()]  # TIGER 1..99 / 2..98
    # Sequential 1..9 (no gaps), TIGER 11x higher: placeholder -> list scale.
    assert dataset.list_range_number(9, [1, 3, 5, 7, 9], segs, min_inflation=2.0) == 99
    # Distance-based 11, 41, 71 (big gaps): TIGER's range is kept.
    assert dataset.list_range_number(71, [11, 41, 71], segs, min_inflation=2.0) == 71
    # TIGER close to the list (1..99 vs 1..79): kept.
    assert dataset.list_range_number(79, list(range(1, 80, 2)), segs, min_inflation=2.0) == 79


def test_main_road_first_claims_a_confident_building_from_the_side_street():
    from address_inference import order
    address_df = pd.DataFrame([
        {"id": "main173", "number": 173, "street": "MAIN", "scorable": True},
        {"id": "side4", "number": 4, "street": "SIDE", "scorable": True},
    ])
    positions = {("MAIN", "corner"): 10.0, ("MAIN", "other"): 90.0,
                 ("SIDE", "corner"): 5.0, ("SIDE", "house4"): 60.0}
    scored = pd.DataFrame([
        ("main173", "corner", 5.0, True), ("main173", "other", 0.0, True),
        ("side4", "corner", 3.0, True), ("side4", "house4", 2.0, True),
    ], columns=["address_id", "source_id", "score", "same_side"])
    fallback = {"main173": "corner", "side4": "corner"}
    alone = order.order_constrained_picks(address_df, scored, positions, fallback)
    assert alone["side4"] == "corner"  # both streets take the corner house
    prio = order.street_priority(address_df, {"MAIN": 2, "SIDE": 3})
    assert prio == ["MAIN", "SIDE"]
    first = order.order_constrained_picks(address_df, scored, positions, fallback, street_order=prio)
    assert first == {"main173": "corner", "side4": "house4"}
    # Not confident enough to claim: the side street keeps its own choice.
    timid = order.order_constrained_picks(address_df, scored, positions, fallback, street_order=prio, claim_min_p=1.01)
    assert timid["side4"] == "corner"


# --- dead ends -------------------------------------------------------------------


def test_beyond_end_is_ahead_of_the_road_not_beside_it():
    pts = [(-70.105, 43.85), (-70.095, 43.85)]  # west -> east, ends at -70.095
    assert dataset.beyond_end(pts, 1, 43.8501, -70.0940)       # ~80 m past the end, ~11 m off-line
    assert not dataset.beyond_end(pts, 1, 43.8510, -70.0948)   # beside the last stretch (behind the end)
    assert not dataset.beyond_end(pts, 1, 43.8520, -70.0945)   # past the end but mostly sideways (>45 deg)
    assert dataset.beyond_end(pts, 0, 43.8499, -70.1060)       # past the START end too
    assert not dataset.beyond_end(pts, 0.5, 43.8501, -70.0940)  # not at an end at all


def test_a_house_past_the_dead_end_counts_for_either_side():
    # h_end sits ~80 m past the east end, digitized slightly to the RIGHT
    # (south) -- but the left (odd) side's number may still take it.
    rows = candidate_rows() + [("MAIN STREET", "h_end", "1", "R", 1.0, True, 80, 150, "Residential",
                                "Single Family Dwelling", None, 43.84995, -70.0940, "1", 80)]
    _, cand = dataset.build([("e1", 99, "MAIN STREET", "exact", 43.84995, -70.0940, "h_end")], [SEGMENT], rows)
    row = cand.set_index("source_id")
    assert row.at["h_end", "beyond_end"] and row.at["h_end", "same_side"]
    assert not row.at["s1", "beyond_end"] and not row.at["s1", "same_side"]
