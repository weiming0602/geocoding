import pandas as pd

from address_inference.loners import access_streets, one_number, street_filter

ADDR = pd.DataFrame({"id": ["chart31", "bristol11", "hh22", "hn183"],
                     "street": ["CHART HOUSE ROAD", "BRISTOL WAY", "HARPSWELL HARBOR DRIVE", "HARPSWELL NECK ROAD"],
                     "number": [31, 11, 22, 183]})


def test_a_loner_belongs_to_the_street_its_driveway_reaches():
    # 11 Bristol Way's house, 62 m from any other building, is a candidate for both streets;
    # its driveway reaches Bristol Way, so 31 Chart House Road may not take it.
    scored = pd.DataFrame({"address_id": ["chart31", "bristol11"], "source_id": ["loner", "loner"],
                           "dist_vs_nearest_road": [12.0, 0.0], "score": [0.9, 0.4]})
    owners = access_streets(scored, ADDR, {"loner"}, {"loner": "BRISTOL WAY"})
    assert owners == {"loner": {"BRISTOL WAY"}}
    assert list(street_filter(scored, ADDR, owners)["address_id"]) == ["bristol11"]


def test_without_access_data_the_nearest_road_owns_the_loner():
    scored = pd.DataFrame({"address_id": ["chart31", "bristol11"], "source_id": ["loner", "loner"],
                           "dist_vs_nearest_road": [12.0, 0.0], "score": [0.9, 0.4]})
    assert access_streets(scored, ADDR, {"loner"}, {}) == {"loner": {"BRISTOL WAY"}}


def test_two_numbers_on_one_loner_keep_one_and_move_the_other():
    scored = pd.DataFrame({"address_id": ["hh22", "hh22", "hn183", "hn183"],
                           "source_id": ["loner", "hh22_house", "loner", "hn183_house"],
                           "dist_vs_nearest_road": [0.0, 0.0, 30.0, 0.0], "score": [0.5, 0.4, 0.8, 0.3]})
    picks = {"hh22": "loner", "hn183": "loner"}
    got = one_number(picks, scored, ADDR, {"loner"}, {"loner": {"HARPSWELL HARBOR DRIVE"}})
    assert got == {"hh22": "loner", "hn183": "hn183_house"}
