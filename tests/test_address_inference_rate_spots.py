import math

import pandas as pd

from address_inference.rate_spots import add_rate_features


def test_spot_is_start_plus_number_times_rate_from_the_numbers_end():
    # Bayview-like: numbers grow from the far end of the line (direction -1),
    # 2,130 m long, highest number 283 -> 7.53 m per number.
    spots = {"BAYVIEW ROAD": (2130.0, -1, 2130.0 / 283, 2130.0, 30), None: 7.66}
    address_df = pd.DataFrame({"id": ["a250", "a252"], "number": [250, 252]})
    candidate_df = pd.DataFrame({
        "address_id": ["a252", "a252", "a250"],
        "street": ["BAYVIEW ROAD"] * 3,
        "source_id": ["house252", "core", "house252"],
    })
    positions = {("BAYVIEW ROAD", "house252"): 178.0, ("BAYVIEW ROAD", "core"): 119.0}
    out = add_rate_features(candidate_df, address_df, spots, positions)
    spot252 = 2130.0 - 252 * 2130.0 / 283
    assert math.isclose(out["d_rate_len"][0], abs(178.0 - spot252))
    assert math.isclose(out["d_rate_len"][1], abs(119.0 - spot252))
    # 252's house is nearer 252's spot than the core building is
    assert out["d_rate_len"][0] < out["d_rate_len"][1]
    assert math.isclose(out["d_rate_town"][2], abs(178.0 - (2130.0 - 250 * 7.66)))


def test_unknown_street_or_position_is_nan():
    spots = {None: 7.66}
    address_df = pd.DataFrame({"id": ["a1"], "number": [10]})
    candidate_df = pd.DataFrame({"address_id": ["a1"], "street": ["NOWHERE RD"], "source_id": ["b"]})
    out = add_rate_features(candidate_df, address_df, spots, {})
    assert out["d_rate_len"].isna().all() and out["d_rate_town"].isna().all()


def test_median_step_tells_sequence_from_distance_numbering():
    from address_inference.rate_spots import median_step
    holbrook = [5, 6, 7, 8, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 30]
    bayview = [3, 23, 26, 28, 43, 51, 53, 57, 59, 60, 63, 66, 75, 79, 84, 89, 94, 99, 102, 105, 107, 110,
               113, 117, 122, 124, 130, 156, 160, 170, 220, 240, 246, 250, 252, 270, 281, 283]
    assert median_step(holbrook) == 2
    assert median_step(bayview) >= 4


def test_anchored_spots_spread_numbers_past_the_last_anchor_to_the_road_end():
    from address_inference.order import anchored_spots
    # Bayview: numbers grow from the start at 2,142 m toward the far end at 0;
    # last confident anchor 170 at 828 m, highest number 283 at the far end.
    spot = (2142.0, -1, 2142.0 / 283, 2142.0, 38)
    out = anchored_spots("BAYVIEW ROAD", [170, 220, 240, 252, 270, 283], [(130, 1111.0), (170, 828.0)], spot)
    assert out[170] == 828.0
    assert abs(out[240] - (828 - 70 * 828 / 113)) < 1e-6   # ~315 m (E911's house: 299 m)
    assert abs(out[270] - (828 - 100 * 828 / 113)) < 1e-6  # ~95 m (E911's house: 87 m)
    assert out[283] == 0.0
