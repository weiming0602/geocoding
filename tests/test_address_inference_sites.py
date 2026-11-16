from address_inference.sites import assign, numbered_buildings

# Bowdoin's Schiller Coastal Studies Center, end of Bayview Road (Harpswell): along_m from the street line's
# far end (numbers grow toward 0 -> direction -1), meters off the centerline, size, nearest other building.
BOWDOIN = [
    dict(source_id="h240", along_m=299, off_m=24, m2=321, alone_m=17),
    dict(source_id="h246", along_m=244, off_m=17, m2=272, alone_m=17),
    dict(source_id="h250", along_m=204, off_m=17, m2=124, alone_m=22),
    dict(source_id="b252", along_m=178, off_m=179, m2=148, alone_m=144),   # alone, reached by a trail
    dict(source_id="core_small", along_m=169, off_m=31, m2=71, alone_m=47),  # shed-sized
    dict(source_id="lab", along_m=115, off_m=91, m2=658, alone_m=12),        # core, own loop
    dict(source_id="core1", along_m=115, off_m=41, m2=202, alone_m=6),
    dict(source_id="core2", along_m=115, off_m=56, m2=201, alone_m=6),
    dict(source_id="core3", along_m=123, off_m=84, m2=216, alone_m=12),
    dict(source_id="h270", along_m=87, off_m=16, m2=205, alone_m=25),
    dict(source_id="h281", along_m=-17, off_m=17, m2=277, alone_m=9),        # past the line's end
    dict(source_id="h283", along_m=-37, off_m=37, m2=495, alone_m=9),
]


def test_site_numbers_main_drive_and_alone_buildings_not_the_core():
    homes = [sid for _q, sid in numbered_buildings(BOWDOIN)]
    assert set(homes) == {"h240", "h246", "h250", "b252", "h270", "h281", "h283"}


def test_bowdoin_numbers_go_in_drive_order_and_the_gate_stays_out():
    numbers = [220, 240, 246, 250, 252, 270, 281, 283]
    # road-start spots (start 2,142 m, 7.57 m per number, numbers grow toward the far end)
    spots = {n: 2142 - n * 7.57 for n in numbers}
    got = assign(numbers, spots, numbered_buildings(BOWDOIN), direction=-1)
    assert got == {240: "h240", 246: "h246", 250: "h250", 252: "b252", 270: "h270", 281: "h281", 283: "h283"}


def test_fewer_numbers_than_buildings_is_not_this_pattern():
    assert assign([240, 246], {240: 300.0, 246: 250.0}, [(299, "a"), (244, "b"), (204, "c")], -1) == {}


def test_campus_means_mostly_non_residential_buildings():
    from address_inference.sites import is_campus
    assert is_campus([dict(occ="Education")] * 12)
    assert not is_campus([dict(occ="Residential")] * 9 + [dict(occ="Commercial")])
