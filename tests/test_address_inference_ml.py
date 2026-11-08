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


def test_a_house_past_the_dead_end_counts_for_either_side(monkeypatch):
    monkeypatch.setattr(dataset, "DEAD_END_SIDE", "either")
    # h_end sits ~80 m past the east end, digitized slightly to the RIGHT
    # (south) -- but the left (odd) side's number may still take it.
    rows = candidate_rows() + [("MAIN STREET", "h_end", "1", "R", 1.0, True, 80, 150, "Residential",
                                "Single Family Dwelling", None, 43.84995, -70.0940, "1", 80)]
    _, cand = dataset.build([("e1", 99, "MAIN STREET", "exact", 43.84995, -70.0940, "h_end")], [SEGMENT], rows)
    row = cand.set_index("source_id")
    assert row.at["h_end", "beyond_end"] and row.at["h_end", "same_side"]
    assert not row.at["s1", "beyond_end"] and not row.at["s1", "same_side"]



def test_axis_rule_sides_a_dead_end_house_by_the_streets_overall_direction(monkeypatch):
    monkeypatch.setattr(dataset, "DEAD_END_SIDE", "axis")
    rows = candidate_rows() + [
        # past the east end, north of the road's start->end line: left (odd)
        ("MAIN STREET", "n_end", "1", "R", 1.0, True, 80, 150, "Residential", "Single Family Dwelling", None,
         43.85005, -70.0940, "1", 80),
        # past the east end, south of it: right (even)
        ("MAIN STREET", "s_end", "1", "L", 1.0, True, 80, 150, "Residential", "Single Family Dwelling", None,
         43.84995, -70.0940, "1", 80),
    ]
    _, cand = dataset.build([("e1", 99, "MAIN STREET", "exact", 43.85005, -70.0940, "n_end")], [SEGMENT], rows)
    row = cand.set_index("source_id")
    assert row.at["n_end", "same_side"] and not row.at["s_end", "same_side"]  # 99 is odd: left side


def test_order_takes_no_building_much_nearer_another_road():
    from address_inference import order
    address_df = pd.DataFrame([{"id": "a4", "number": 4, "street": "SIDE", "scorable": True}])
    positions = {("SIDE", "corner"): 1.0, ("SIDE", "own"): 50.0}
    scored = pd.DataFrame([
        ("a4", "corner", 3.0, True, 42.0), ("a4", "own", 2.0, True, 0.0),
    ], columns=["address_id", "source_id", "score", "same_side", "dist_vs_nearest_road"])
    picks = order.order_constrained_picks(address_df, scored, positions, {"a4": "corner"})
    assert picks["a4"] == "own"  # the corner house is 42 m nearer another road
    kept = order.order_constrained_picks(address_df, scored, positions, {"a4": "corner"}, other_road_closer_m=60)
    assert kept["a4"] == "corner"


def test_monotone_assign_caps_a_building_at_two_numbers():
    from address_inference import order
    P = np.array([[0.9, 0.0], [0.9, 0.1], [0.9, 0.2]])
    _, two = order.monotone_assign(P, share_penalty=0.1, max_per_building=2)
    assert two == {0: 0, 1: 0, 2: 1}
    _, strict = order.monotone_assign(P, share_penalty=np.inf)
    assert sorted(strict.values()) == [0, 1]  # one number per building, one left over


def test_townhouse_side_deals_numbers_out_two_per_building_in_road_order():
    from address_inference import order
    # 8 sequential even numbers, 4 townhouse buildings in road order; the
    # ranker's scores all lean one building too early (houses start well
    # into the road), as on Harvest Ridge Road.
    nums = [26, 28, 30, 32, 34, 36, 38, 40]
    blds = ["b1", "b2", "b3", "b4"]
    address_df = pd.DataFrame([{"id": f"a{n}", "number": n, "street": "HR", "scorable": True} for n in nums])
    positions = {("HR", b): 100.0 * (i + 1) for i, b in enumerate(blds)}
    rows = []
    for i, n in enumerate(nums):
        right = i // 2
        early = max(0, right - 1)
        for j, b in enumerate(blds):
            rows.append((f"a{n}", b, 2.0 if j == early else (1.0 if j == right else 0.0), True, 0.0))
    scored = pd.DataFrame(rows, columns=["address_id", "source_id", "score", "same_side", "dist_vs_nearest_road"])
    picks = order.order_constrained_picks(address_df, scored, positions, {})
    assert [picks[f"a{n}"] for n in nums] == ["b1", "b1", "b2", "b2", "b3", "b3", "b4", "b4"]


def test_townhouse_street_puts_an_odd_number_in_an_even_side_building():
    from address_inference import order
    # Harvest Ridge Road in miniature, buildings in road order: right b1
    # (18, 19, 20), left b2 (21, 23), right b3 (24, 26), right b4 (28, 30).
    layout = {18: "b1", 19: "b1", 20: "b1", 21: "b2", 23: "b2", 24: "b3", 26: "b3", 28: "b4", 30: "b4"}
    side = {"b1": 0, "b3": 0, "b4": 0, "b2": 1}  # parity whose side the building is on
    address_df = pd.DataFrame([{"id": f"a{n}", "number": n, "street": "HR", "scorable": True} for n in layout])
    positions = {("HR", b): 100.0 + 50 * i for i, b in enumerate(("b1", "b2", "b3", "b4"))}
    rows = []
    for n, truth in layout.items():
        for b in side:
            rows.append((f"a{n}", b, 1.0 if b == truth else 0.5, side[b] == n % 2, 0.0))
    scored = pd.DataFrame(rows, columns=["address_id", "source_id", "score", "same_side", "dist_vs_nearest_road"])
    picks = order.order_constrained_picks(address_df, scored, positions, {})
    assert {n: picks.get(f"a{n}") for n in layout} == layout
    separate = order.order_constrained_picks(address_df, scored, positions, {}, joint_townhouses=False)
    assert separate.get("a19") != "b1"  # side by side, 19 can't join 18 and 20



# --- parcels -----------------------------------------------------------------------


def test_parcel_features_compare_frontage_on_this_street_with_others():
    parcels = {"buildings": {"back": {"parcel": "p15", "area": 2933.0, "buildings": 2, "largest": False}},
               "frontage": {"p15": {"summer1": 68.0, "village1": 32.0, "village2": 7.0}}}
    f = dataset._parcel_features("back", {"summer1"}, parcels)
    assert f["parcel_frontage_this"] == 68 and f["parcel_frontage_other"] == 39
    assert f["parcel_frontage_share"] == pytest.approx(68 / 107)
    assert f["parcel_buildings"] == 2 and f["parcel_largest"] == 0.0
    missing = dataset._parcel_features("nowhere", {"summer1"}, parcels)
    assert all(np.isnan(v) for v in missing.values())
    assert np.isnan(dataset._parcel_features("back", {"summer1"}, None)["parcel_area_m2"])


def test_summary_counts_each_street_number_once():
    # 563 points of "141 Main" all wrong, one right single-family house:
    # per point that's 0.2% right; per address number, 50%.
    scored = pd.DataFrame(
        [{"street": "MAIN", "number": 141, "error_m": 200.0, "right_building": False, "right_property": False,
          "has_true_building": True}] * 563
        + [{"street": "ELM", "number": 7, "error_m": 5.0, "right_building": True, "right_property": True,
            "has_true_building": True}])
    s = evaluate.summarize("x", scored)
    assert s["right building"] == pytest.approx(0.5) and s["right building (per point)"] == pytest.approx(1 / 564)
    assert s["numbers"] == 2


def test_order_keeps_a_shed_out_and_follows_the_ranges_direction():
    from address_inference import order
    # 12's lot: house (pos 100) and a shed at 15% of its size (pos 60);
    # 44's house at pos 400. The ranges run low -> high with position.
    address_df = pd.DataFrame([{"id": "a12", "number": 12, "street": "BC", "scorable": True},
                               {"id": "a44", "number": 44, "street": "BC", "scorable": True},
                               {"id": "a30", "number": 30, "street": "BC", "scorable": True}])
    positions = {("BC", "house12"): 100.0, ("BC", "shed"): 60.0, ("BC", "house30"): 250.0, ("BC", "house44"): 400.0}
    rows = [("a12", "shed", 2.0, 2, 0.15, 0.0), ("a12", "house12", 1.9, 2, 1.0, 10.0),
            ("a30", "house30", 2.0, 1, 1.0, 0.0), ("a30", "house12", 0.5, 2, 1.0, 120.0),
            ("a44", "house12", 2.5, 2, 1.0, 290.0), ("a44", "house44", 2.0, 1, 1.0, 0.0)]
    scored = pd.DataFrame([(aid, b, sc, True, nb, ratio, d, 0.0) for aid, b, sc, nb, ratio, d in rows],
                          columns=["address_id", "source_id", "score", "same_side", "parcel_buildings",
                                   "parcel_size_ratio", "d_m0", "dist_vs_nearest_road"])
    picks = order.order_constrained_picks(address_df, scored, positions, {})
    assert picks == {"a12": "house12", "a30": "house30", "a44": "house44"}


def test_rural_extra_building_much_smaller_than_the_side_gives_way():
    from address_inference import order
    # One number, two home buildings on big rural lots: a 60 m2 outbuilding
    # nearer the interpolated point and the 250 m2 house. The ranker slightly
    # prefers the outbuilding; at 4x smaller than the side's median it gives way.
    address_df = pd.DataFrame([{"id": "a5", "number": 5, "street": "RR", "scorable": True}])
    positions = {("RR", "out"): 100.0, ("RR", "house"): 140.0}
    scored = pd.DataFrame([("a5", "out", 1.1, True, 60.0, 9000.0, 0.0), ("a5", "house", 1.0, True, 250.0, 9000.0, 0.0)],
                          columns=["address_id", "source_id", "score", "same_side", "sqmeters", "parcel_area_m2",
                                   "dist_vs_nearest_road"])
    assert order.order_constrained_picks(address_df, scored, positions, {}, extra_small_penalty=0)["a5"] == "out"
    assert order.order_constrained_picks(address_df, scored, positions, {})["a5"] == "house"


def test_a_two_house_lot_is_one_place_so_numbers_dont_shift():
    from address_inference import order
    # Brickyard Cove: lot 42 has a front house (pos 315) and the E911 house
    # (pos 397); 22's house is at 336. As separate places 22 takes lot 42's
    # front house; as one lot (mean 356) 22 keeps its own.
    address_df = pd.DataFrame([{"id": f"a{n}", "number": n, "street": "BC", "scorable": True} for n in (22, 42)])
    positions = {("BC", "front42"): 315.0, ("BC", "house22"): 336.0, ("BC", "back42"): 397.0}
    rows = [("a22", "front42", 2.0), ("a22", "house22", 1.0), ("a22", "back42", 0.0),
            ("a42", "back42", 2.0), ("a42", "front42", 1.5), ("a42", "house22", 0.5)]
    scored = pd.DataFrame([(aid, b, sc, True, 0.0) for aid, b, sc in rows],
                          columns=["address_id", "source_id", "score", "same_side", "dist_vs_nearest_road"])
    apart = order.order_constrained_picks(address_df, scored, positions, {})
    assert apart["a22"] == "front42"
    lots = order.lot_picks(address_df, scored, positions, {}, {"front42": "lot42", "back42": "lot42", "house22": "lot22"})
    assert lots == {"a22": "house22", "a42": "back42"}


def test_a_big_complex_keeps_its_own_pick_and_its_building():
    from address_inference import order
    # 141 has 60 points on building c; road order alone would hand c to 135
    # (which scores it higher) and push 141 along to d.
    rows = [{"id": "a135", "number": 135, "street": "MAIN", "scorable": True}]
    rows += [{"id": f"u{i}", "number": 141, "street": "MAIN", "scorable": True} for i in range(60)]
    address_df = pd.DataFrame(rows)
    positions = {("MAIN", "b"): 10.0, ("MAIN", "c"): 20.0, ("MAIN", "d"): 30.0}
    sc = [("a135", "c", 2.0), ("a135", "b", 1.0)] + [(f"u{i}", b, s) for i in range(60) for b, s in (("c", 1.5), ("d", 1.4))]
    scored = pd.DataFrame([(a, b, s, True) for a, b, s in sc], columns=["address_id", "source_id", "score", "same_side"])
    fallback = {"a135": "c", **{f"u{i}": "c" for i in range(60)}}
    picks = order.order_constrained_picks(address_df, scored, positions, fallback)
    assert picks["u0"] == "c" and picks["a135"] == "b"
    unlocked = order.order_constrained_picks(address_df, scored, positions, fallback, lock_min_points=0)
    assert unlocked["u0"] == "d"


def test_a_building_with_a_pool_is_never_a_shed():
    from address_inference import order
    # 59's small building (25% of its lot's biggest) would be dropped as a
    # shed -- unless there's a pool next to it.
    address_df = pd.DataFrame([{"id": "a59", "number": 59, "street": "LM", "scorable": True}])
    positions = {("LM", "small"): 10.0, ("LM", "big"): 50.0}
    base = [("a59", "small", 2.0, True, 2, 0.15, 0.0), ("a59", "big", 1.0, True, 2, 1.0, 0.0)]
    cols = ["address_id", "source_id", "score", "same_side", "parcel_buildings", "parcel_size_ratio",
            "dist_vs_nearest_road"]
    no_pool = pd.DataFrame(base, columns=cols)
    assert order.order_constrained_picks(address_df, no_pool, positions, {})["a59"] == "big"
    with_pool = no_pool.assign(pool_m=[8.5, np.nan])
    assert order.order_constrained_picks(address_df, with_pool, positions, {})["a59"] == "small"


def test_driveway_rules_are_on_by_default():
    from address_inference import order
    # The building 40 m nearer another road would be dropped -- but its
    # driveway clearly comes to THIS street, so by default it stays.
    address_df = pd.DataFrame([{"id": "a48", "number": 48, "street": "FP", "scorable": True}])
    positions = {("FP", "deep"): 10.0, ("FP", "near"): 50.0}
    scored = pd.DataFrame([("a48", "deep", 2.0, True, 94.0, 1.0, 1.0), ("a48", "near", 1.0, True, 0.0, 3.0, 0.0)],
                          columns=["address_id", "source_id", "score", "same_side", "dist_vs_nearest_road",
                                   "drive_ratio", "drive_best"])
    assert order.order_constrained_picks(address_df, scored, positions, {})["a48"] == "deep"
    assert order.order_constrained_picks(address_df, scored, positions, {}, driveway_rules=False)["a48"] == "near"


def test_corner_buildings_need_a_clearer_driveway():
    from address_inference import order
    # Both buildings' driveways favor another road 2x. The set-back one
    # (60 m from its nearest road) is dropped; the corner one (20 m) is
    # kept, since 2x is below the corner bar.
    address_df = pd.DataFrame([{"id": "a1", "number": 1, "street": "C", "scorable": True}])
    positions = {("C", "set_back"): 10.0, ("C", "corner"): 50.0}
    cols = ["address_id", "source_id", "score", "same_side", "dist_vs_nearest_road", "dist_road", "drive_ratio", "drive_best"]
    scored = pd.DataFrame([("a1", "set_back", 2.0, True, 0.0, 60.0, 2.0, 0.0),
                           ("a1", "corner", 1.0, True, 0.0, 20.0, 2.0, 0.0)], columns=cols)
    assert order.order_constrained_picks(address_df, scored, positions, {})["a1"] == "corner"
    assert order.lot_picks(address_df, scored, positions, {}, {"set_back": "p1", "corner": "p2"})["a1"] == "corner"


def test_a_lot_goes_to_the_street_that_wants_it_most_unless_its_driveway_says_otherwise():
    from address_inference import order
    # 48 on Main St (assigned first, a main road) vs 2 on Side Rd both want
    # lot L; Side Rd's 2 wants it far more, so Main's 48 takes its own house.
    address_df = pd.DataFrame([{"id": "m48", "number": 48, "street": "MAIN ST", "scorable": True},
                               {"id": "s2", "number": 2, "street": "SIDE RD", "scorable": True}])
    positions = {("MAIN ST", "garage"): 10.0, ("MAIN ST", "house48"): 50.0, ("SIDE RD", "garage"): 5.0, ("SIDE RD", "house2"): 6.0}
    cols = ["address_id", "source_id", "score", "same_side", "drive_best"]
    rows = [("m48", "garage", 2.0, True, 0.0), ("m48", "house48", 1.5, True, 0.0),
            ("s2", "house2", 3.0, True, float("nan")), ("s2", "garage", 1.0, True, float("nan"))]
    parcel_of = {"garage": "L", "house2": "L", "house48": "L48"}
    picks = order.lot_picks(address_df, pd.DataFrame(rows, columns=cols), positions, {}, parcel_of,
                            street_order=["MAIN ST", "SIDE RD"])
    assert picks["m48"] == "house48" and picks["s2"] == "house2"
    # ...but if the garage's driveway comes to Main St, the lot stays open to 48.
    rows[0] = ("m48", "garage", 2.0, True, 1.0)
    picks = order.lot_picks(address_df, pd.DataFrame(rows, columns=cols), positions, {}, parcel_of,
                            street_order=["MAIN ST", "SIDE RD"])
    assert picks["m48"] == "garage"


def test_the_house_at_the_end_of_a_visible_lane_is_the_home_and_takes_the_number():
    from address_inference import order
    # Owner's rule: a long lane seen in the imagery leads to a home, not a
    # barn. Lot L has a building 60 m from the road and a house 220 m back
    # at the end of its lane: the ranker likes the front building, but the
    # lane's end takes the number.
    address_df = pd.DataFrame([{"id": "a48", "number": 48, "street": "FP", "scorable": True}])
    positions = {("FP", "front"): 10.0, ("FP", "lane_house"): 12.0}
    cols = ["address_id", "source_id", "score", "same_side", "drive_best", "drive_off_m", "dist_road"]
    rows = [("a48", "front", 2.0, True, 1.0, 1.0, 60.0), ("a48", "lane_house", 1.0, True, 1.0, 3.0, 220.0)]
    parcel_of = {"front": "L", "lane_house": "L"}
    picks = order.lot_picks(address_df, pd.DataFrame(rows, columns=cols), positions, {}, parcel_of)
    assert picks["a48"] == "lane_house"
    # A path mostly across grass (40 m off pavement) is no lane.
    rows[1] = ("a48", "lane_house", 1.0, True, 1.0, 40.0, 220.0)
    picks = order.lot_picks(address_df, pd.DataFrame(rows, columns=cols), positions, {}, parcel_of)
    assert picks["a48"] == "front"


def test_one_lane_leads_to_one_home():
    from address_inference import order
    # 47's lot: its house and a barn both sit at the end of 47's lane. Only
    # the house (the bigger) is the lane's home; counted as a second home,
    # the barn drew 45 off its own house by the road.
    address_df = pd.DataFrame([{"id": "a45", "number": 45, "street": "FP", "scorable": True},
                               {"id": "a47", "number": 47, "street": "FP", "scorable": True}])
    positions = {("FP", "house45"): 10.0, ("FP", "barn47"): 20.0, ("FP", "house47"): 30.0,
                 ("FP", "shed47a"): 31.0, ("FP", "shed47b"): 32.0}
    cols = ["address_id", "source_id", "score", "same_side", "drive_best", "drive_off_m", "dist_road", "sqmeters"]
    lane = (1.0, 5.0, 150.0)
    rows = [("a45", "house45", 1.0, True, float("nan"), float("nan"), 20.0, 120.0),
            ("a45", "barn47", 0.9, True, *lane, 200.0),
            ("a47", "house47", 1.5, True, *lane, 300.0), ("a47", "barn47", 0.5, True, *lane, 200.0)]
    # a lot of 4+ buildings stays separate places in road order
    parcel_of = {"house47": "L47", "barn47": "L47", "shed47a": "L47", "shed47b": "L47", "house45": "L45"}
    picks = order.lot_picks(address_df, pd.DataFrame(rows, columns=cols), positions, {}, parcel_of)
    assert picks == {"a45": "house45", "a47": "house47"}


def test_a_tree_covered_building_is_never_a_shed():
    from address_inference import order
    # 42's house: a third of its outline under trees, traced as a thin strip
    # 15% the size of its lot's biggest building -- a "shed" by size alone.
    address_df = pd.DataFrame([{"id": "a42", "number": 42, "street": "FP", "scorable": True}])
    positions = {("FP", "thin"): 10.0, ("FP", "big"): 50.0}
    cols = ["address_id", "source_id", "score", "same_side", "parcel_buildings", "parcel_size_ratio",
            "dist_vs_nearest_road", "canopy_over"]
    rows = [("a42", "thin", 2.0, True, 2, 0.15, 0.0, 0.31), ("a42", "big", 1.0, True, 2, 1.0, 0.0, 0.04)]
    picks = order.order_constrained_picks(address_df, pd.DataFrame(rows, columns=cols), positions, {})
    assert picks["a42"] == "thin"
    rows[0] = ("a42", "thin", 2.0, True, 2, 0.15, 0.0, 0.0)  # clear roof: a shed
    picks = order.order_constrained_picks(address_df, pd.DataFrame(rows, columns=cols), positions, {})
    assert picks["a42"] == "big"


def test_the_lidar_roof_picks_a_lots_house_when_its_outline_was_cut_short_by_trees(monkeypatch):
    from address_inference import order
    # 42's lot: the ranker prefers the 186 m2 outline at the back; the
    # house's outline is a 78 m2 strip under trees, but lidar sees a 177 m2
    # roof there and only 135 m2 at the back.
    address_df = pd.DataFrame([{"id": "a42", "number": 42, "street": "FP", "scorable": True}])
    positions = {("FP", "house"): 10.0, ("FP", "back"): 12.0}
    cols = ["address_id", "source_id", "score", "same_side", "sqmeters"]
    rows = pd.DataFrame([("a42", "house", 1.0, True, 78.0), ("a42", "back", 2.0, True, 186.0)], columns=cols)
    parcel_of = {"house": "L42", "back": "L42"}
    roof_of = {"house": (177.0, 6.0), "back": (135.0, 4.0)}
    monkeypatch.setattr(order, "WITHIN_LOT", None)
    assert order.lot_picks(address_df, rows, positions, {}, parcel_of, roof_of=roof_of) == {"a42": "back"}
    monkeypatch.setattr(order, "WITHIN_LOT", "lidar")
    assert order.lot_picks(address_df, rows, positions, {}, parcel_of, roof_of=roof_of) == {"a42": "house"}
    # no lidar roof seen: the outline decides
    assert order.lot_picks(address_df, rows, positions, {}, parcel_of, roof_of={}) == {"a42": "back"}


def test_the_assessor_lot_address_picks_the_lots_biggest_building():
    import pandas as pd
    from address_inference import order
    assert order.parse_prop_loc("21 CARRIAGE ROAD") == (21, "CARRIAGE RD")
    assert order.parse_prop_loc("0 CARRIAGE ROAD") is None
    # tax-roll spellings
    assert order.parse_prop_loc("47 LWR MAST LANDING ROAD") == (47, "LOWER MAST LNDG RD")
    assert order.parse_prop_loc("10 MAIN STREET SF") == (10, "MAIN ST S")
    assert order.parse_prop_loc("5 DESERT RD #UNIT 2") == (5, "DESERT RD")
    address_df = pd.DataFrame([{"id": "a21", "number": 21, "street": "CARRIAGE ROAD"},
                               {"id": "a17", "number": 17, "street": "CARRIAGE ROAD"}])
    lots = {(21, "CARRIAGE RD"): ["lot24"]}
    parcel_of = {"house": "lot24", "barn": "lot24", "other": "lot26"}
    size_of = {"house": 150, "barn": 200, "other": 120}
    roof_of = {"house": (260, 7.0), "barn": (190, 5.0)}   # trees hid half the house's outline
    picks, matched = order.assessor_picks(address_df, lots, parcel_of, size_of, {"a21": "other", "a17": "other"},
                                          roof_of=roof_of)
    assert picks == {"a21": "house", "a17": "other"} and matched == {"a21"}
