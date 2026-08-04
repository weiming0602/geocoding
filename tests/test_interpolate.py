import psycopg
import pytest

from geocoding.interpolate import (
    interpolate_address,
    interpolate_along_line,
    parse_linestring,
)
from geocoding.schema import CREATE_TABLE_SQL


def test_parse_linestring():
    points = parse_linestring("LINESTRING (-70.1 43.1, -70.2 43.2, -70.3 43.3)")
    assert points == [(-70.1, 43.1), (-70.2, 43.2), (-70.3, 43.3)]


def test_interpolate_along_line_midpoint():
    points = [(0.0, 0.0), (0.0, 2.0)]
    x, y = interpolate_along_line(points, 0.5)
    assert x == pytest.approx(0.0)
    assert y == pytest.approx(1.0)


def test_interpolate_along_line_offset_right_of_northward_line():
    # Traveling due north, "right" should push east (+x).
    points = [(0.0, 0.0), (0.0, 1.0)]
    x, y = interpolate_along_line(points, 0.5, offset_feet=10, offset_side="right")
    assert x > 0.0
    assert y == pytest.approx(0.5, abs=1e-6)


def test_interpolate_along_line_offset_left_of_northward_line():
    points = [(0.0, 0.0), (0.0, 1.0)]
    x, y = interpolate_along_line(points, 0.5, offset_feet=10, offset_side="left")
    assert x < 0.0
    assert y == pytest.approx(0.5, abs=1e-6)


@pytest.fixture
def conn(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_TABLE_SQL)
        conn.execute(
            """
            INSERT INTO streets (id, fullname, lfromadd, ltoadd, rfromadd, rtoadd, geometry)
            VALUES (12, 'Pequawket Trl', '988', '998', '979', '991',
                    'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)')
            """
        )
        conn.execute(
            """
            INSERT INTO streets (id, fullname, lfromadd, ltoadd, rfromadd, rtoadd, geometry)
            VALUES (1, 'Sebago Rd', '', '', '', '',
                    'LINESTRING (-70.748418 43.876127, -70.750996 43.878619)')
            """
        )
        conn.commit()
        yield conn


def test_interpolate_address_matches_manual_calculation(conn):
    x, y = interpolate_address(conn, street_id=12, number=996, range_side="left")
    assert x == pytest.approx(-70.778463, abs=1e-6)
    assert y == pytest.approx(43.834344, abs=1e-6)


def test_interpolate_address_with_offset_matches_manual_calculation(conn):
    x, y = interpolate_address(
        conn, street_id=12, number=996, range_side="left",
        offset_feet=5, offset_side="right",
    )
    assert x == pytest.approx(-70.778444, abs=1e-6)
    assert y == pytest.approx(43.834346, abs=1e-6)


def test_interpolate_address_out_of_range_raises(conn):
    with pytest.raises(ValueError, match="outside the left range"):
        interpolate_address(conn, street_id=12, number=56, range_side="left")


def test_interpolate_address_out_of_range_allowed_with_flag(conn):
    x, y = interpolate_address(
        conn, street_id=12, number=56, range_side="left", allow_extrapolation=True
    )
    assert isinstance(x, float)
    assert isinstance(y, float)


def test_interpolate_address_missing_range_raises(conn):
    with pytest.raises(ValueError, match="no left address range"):
        interpolate_address(conn, street_id=1, number=56, range_side="left")


def test_interpolate_address_unknown_street_raises(conn):
    with pytest.raises(ValueError, match="no street with id"):
        interpolate_address(conn, street_id=999, number=1, range_side="left")
