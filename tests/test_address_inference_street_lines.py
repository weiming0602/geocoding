from shapely.geometry import LineString, MultiLineString

import address_inference.street_lines as sl


def test_single_line_kept_as_is():
    line = LineString([(0, 0), (1, 0), (2, 0)])
    assert sl.single_line(line).equals(line)


def test_short_spur_at_a_fork_is_trimmed():
    # Ash Point Road's shape: a long road with a short side spur at a fork.
    trunk_a = LineString([(0, 0), (10, 0)])
    trunk_b = LineString([(10, 0), (20, 0)])
    spur = LineString([(10, 0), (10, 1)])
    out = sl.single_line(MultiLineString([trunk_a, trunk_b, spur]))
    assert isinstance(out, LineString)
    assert abs(out.length - 20) < 1e-9


def test_gap_between_pieces_is_chained_in_order():
    a = LineString([(0, 0), (10, 0)])
    c = LineString([(30, 0), (40, 0)])
    b = LineString([(21, 0), (12, 0)])  # digitized backwards
    out = sl.single_line(MultiLineString([a, c, b]))
    xs = [x for x, _ in out.coords]
    assert xs == sorted(xs) or xs == sorted(xs, reverse=True)
    assert len(out.coords) == 6


def test_long_branch_is_not_trimmed_but_chained():
    # a lollipop's access road is no spur: more than SPUR_MAX_SHARE of the street
    tail = LineString([(0, 0), (0, 10)])
    left = LineString([(0, 10), (-1, 11), (0, 12)])
    right = LineString([(0, 10), (1, 11), (0, 12)])
    out = sl.single_line(MultiLineString([tail, left, right]))
    assert isinstance(out, LineString)
    assert out.length >= tail.length


def test_join_off_gives_old_behavior(monkeypatch):
    monkeypatch.setattr(sl, "JOIN_PIECES", False)
    assert sl.single_line(MultiLineString([LineString([(0, 0), (1, 0)]),
                                           LineString([(2, 0), (3, 0)])])) is None
