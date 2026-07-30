"""House-number interpolation along street centerlines.

Given a street segment's address range (e.g. lfromadd/ltoadd) and a
house number, finds where that number sits along the segment's
digitized geometry, optionally offset perpendicular to the line by a
real-world distance (e.g. to nudge the point off the centerline and
onto the correct side of the street).
"""

import argparse
import math
import re
import sqlite3
from typing import Optional

Point = tuple[float, float]

METERS_PER_FOOT = 0.3048


def parse_linestring(wkt: str) -> list[Point]:
    """Parse a WKT LINESTRING into a list of (lon, lat) points."""
    match = re.match(r"\s*LINESTRING\s*\((.*)\)\s*$", wkt)
    if not match:
        raise ValueError(f"expected a WKT LINESTRING, got: {wkt!r}")
    return [tuple(map(float, p.split())) for p in match.group(1).split(",")]


def _meters_per_degree(lat: float) -> tuple[float, float]:
    """Approximate (meters_per_degree_lon, meters_per_degree_lat) at a latitude."""
    lat_rad = math.radians(lat)
    return 111320.0 * math.cos(lat_rad), 111320.0


def interpolate_along_line(
    points: list[Point],
    fraction: float,
    offset_feet: float = 0.0,
    offset_side: str = "right",
) -> Point:
    """Find the point at `fraction` of the way along a line.

    `offset_side` rotates the direction of travel -90 degrees ("right")
    or +90 degrees ("left") to push the result off the centerline by
    `offset_feet`, converting feet to degrees locally at that latitude.
    """
    if offset_side not in ("left", "right"):
        raise ValueError("offset_side must be 'left' or 'right'")

    seg_lens = [
        math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(points, points[1:])
    ]
    total_len = sum(seg_lens)
    target = fraction * total_len

    dist_so_far = 0.0
    for (x1, y1), (x2, y2), seg_len in zip(points, points[1:], seg_lens):
        if dist_so_far + seg_len >= target or seg_len == 0:
            t = (target - dist_so_far) / seg_len if seg_len else 0.0
            x, y = x1 + t * (x2 - x1), y1 + t * (y2 - y1)
            seg_dx, seg_dy = x2 - x1, y2 - y1
            break
        dist_so_far += seg_len
    else:
        (x1, y1), (x2, y2) = points[-2], points[-1]
        x, y = x2, y2
        seg_dx, seg_dy = x2 - x1, y2 - y1

    if offset_feet == 0:
        return x, y

    m_per_deg_lon, m_per_deg_lat = _meters_per_degree(y)
    dx_m, dy_m = seg_dx * m_per_deg_lon, seg_dy * m_per_deg_lat
    seg_len_m = math.hypot(dx_m, dy_m)

    if offset_side == "right":
        unit_m = (dy_m / seg_len_m, -dx_m / seg_len_m)
    else:
        unit_m = (-dy_m / seg_len_m, dx_m / seg_len_m)

    offset_m = offset_feet * METERS_PER_FOOT
    offset_x_deg = (unit_m[0] * offset_m) / m_per_deg_lon
    offset_y_deg = (unit_m[1] * offset_m) / m_per_deg_lat

    return x + offset_x_deg, y + offset_y_deg


def interpolate_address(
    conn: sqlite3.Connection,
    street_id: int,
    number: int,
    range_side: str = "left",
    offset_feet: float = 0.0,
    offset_side: Optional[str] = None,
    allow_extrapolation: bool = False,
) -> Point:
    """Interpolate the coordinates of `number` along a `streets` row's geometry.

    `range_side` selects which address range to interpolate against:
    "left" uses lfromadd/ltoadd, "right" uses rfromadd/rtoadd. `offset_side`
    defaults to `range_side` (TIGER's ranges describe the side of the
    street the addresses fall on), but can be overridden.
    """
    if range_side not in ("left", "right"):
        raise ValueError("range_side must be 'left' or 'right'")
    from_col, to_col = (
        ("lfromadd", "ltoadd") if range_side == "left" else ("rfromadd", "rtoadd")
    )

    row = conn.execute(
        f"SELECT {from_col}, {to_col}, geometry FROM streets WHERE id = ?",
        (street_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"no street with id={street_id}")

    from_raw, to_raw, geometry = row
    if not from_raw or not to_raw:
        raise ValueError(
            f"street id={street_id} has no {range_side} address range to interpolate"
        )
    from_num, to_num = int(from_raw), int(to_raw)

    fraction = (number - from_num) / (to_num - from_num)
    if not allow_extrapolation and not 0.0 <= fraction <= 1.0:
        raise ValueError(
            f"number {number} is outside the {range_side} range "
            f"{from_num}-{to_num} for street id={street_id} "
            f"(pass allow_extrapolation=True to override)"
        )

    points = parse_linestring(geometry)
    return interpolate_along_line(
        points,
        fraction,
        offset_feet=offset_feet,
        offset_side=offset_side or range_side,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interpolate the coordinates of a house number along a street segment."
    )
    parser.add_argument("database", help="Path to the SQLite database")
    parser.add_argument("street_id", type=int, help="id of the row in the streets table")
    parser.add_argument("number", type=int, help="House number to interpolate")
    parser.add_argument(
        "--range-side", choices=["left", "right"], default="left",
        help="Which address range to use (default: left)",
    )
    parser.add_argument(
        "--offset-feet", type=float, default=0.0,
        help="Perpendicular offset from the centerline, in feet (default: 0)",
    )
    parser.add_argument(
        "--offset-side", choices=["left", "right"], default=None,
        help="Which side to offset toward (default: same as --range-side)",
    )
    parser.add_argument(
        "--allow-extrapolation", action="store_true",
        help="Allow numbers outside the address range",
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.database)
    try:
        x, y = interpolate_address(
            conn,
            args.street_id,
            args.number,
            range_side=args.range_side,
            offset_feet=args.offset_feet,
            offset_side=args.offset_side,
            allow_extrapolation=args.allow_extrapolation,
        )
    finally:
        conn.close()

    print(f"{x:.6f}, {y:.6f}")


if __name__ == "__main__":
    main()
