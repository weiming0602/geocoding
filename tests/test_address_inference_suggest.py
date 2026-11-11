"""address_inference.suggest: numbers for houses E911 never numbered."""

from address_inference import suggest

# Flying Point Road around 42: evens on the left (+1), odds on the right
# (-1), numbers rising along the road; no 44 (or 40, 46).
FLYING_POINT = [
    (38, 80.0, 1), (42, 100.0, 1), (48, 200.0, 1),
    (39, 85.0, -1), (41, 95.0, -1), (43, 110.0, -1), (45, 150.0, -1), (47, 190.0, -1),
]


def test_a_house_behind_42_gets_44():
    s = suggest.suggest_number(FLYING_POINT, 112.0, 1)
    assert (s.number, s.before, s.after) == (44, 42, 48)


def test_the_number_follows_the_distance_between_the_neighbors():
    # 160 m: past 45 (150 m) and toward 47 -> 46, not 44
    assert suggest.suggest_number(FLYING_POINT, 160.0, 1).number == 46


def test_the_odd_side_gets_an_odd_number():
    # past 47 (190 m) on the odd side
    assert suggest.suggest_number(FLYING_POINT, 195.0, -1).number in (49, 51)


def test_no_suggestion_when_the_neighbors_leave_no_room():
    points = [(42, 100.0, 1), (44, 200.0, 1), (43, 150.0, -1)]
    s = suggest.suggest_number(points, 150.0, 1)
    assert s.number is None and "42" in s.reason


def test_past_the_last_number_it_keeps_going_the_way_the_street_runs():
    # the last two numbers (47 at 190 m, 48 at 200 m) rise 1 per 10 m: 60 m past 48 -> 54
    s = suggest.suggest_number(FLYING_POINT, 260.0, 1)
    assert (s.number, s.before, s.after, s.reason) == (54, 48, None, "past the end")


def test_a_side_with_no_numbers_takes_the_other_parity():
    points = [(1, 0.0, -1), (3, 10.0, -1), (5, 20.0, -1)]
    assert suggest.suggest_number(points, 10.0, 1).number % 2 == 0


def test_only_houses_get_numbers_and_a_garage_does_not():
    # lot L1: house 42 (177 m2, numbered) + a 135 m2, 4 m back house + a 40 m2 shed
    # lot L2: one house, no E911 point anywhere on the lot
    buildings = [
        ("front", "Residential", "Single Family Dwelling", 177, 6.0, "L1", 0, 0),
        ("back", "Residential", "Single Family Dwelling", 135, 4.0, "L1", 0, 0),
        ("shed", "Residential", "Single Family Dwelling", 40, 3.0, "L1", 0, 0),
        ("new", "Residential", "Single Family Dwelling", 150, 5.0, "L2", 0, 0),
        ("store", "Commercial", "Retail Trade", 300, 6.0, "L3", 0, 0),
    ]
    all_points = [("p42", "front", "L1")]
    assert suggest.unnumbered_houses(all_points, buildings) == {"back": "second house", "new": "unnumbered lot"}


def test_a_deep_house_is_placed_within_its_lots_frontage():
    # House projects at 300 m, but its lot meets this street only at 100-140 m
    # (a back lot reached down a long drive): it is numbered there.
    streets = [("deep", "CARRIAGE ROAD", 70.0, 300.0, 1), ("deep", "OTHER ROAD", 60.0, 10.0, 1)]
    fronts = [("deep", "CARRIAGE ROAD", 120.0, 100.0, 140.0)]
    assert suggest.placements(streets, [], fronts, "within lot") == {"deep": ("CARRIAGE ROAD", 140.0, 1)}
    # without the lot: the nearer road, at the house
    assert suggest.placements(streets, [], fronts, "house") == {"deep": ("OTHER ROAD", 10.0, 1)}
