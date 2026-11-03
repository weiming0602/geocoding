"""Draws the fixed benchmark sample from Maine E911 address points.

    python -m benchmarks.sample "dbname=geocoding" --size 300

Deterministic (ordered by md5(site_uid || SEED)), and the result is
committed as a CSV, so every future run scores the exact same addresses
even after E911 itself is refreshed. Draw a new sample only on purpose,
with a new SEED and file name, and note it in RESULTS.md, since results
on different samples aren't comparable.
"""

import argparse
import csv
from pathlib import Path

import psycopg

SEED = "meridian-benchmark-2026-11-03"
DATA_DIR = Path(__file__).parent / "data"

SAMPLE_SQL = """
SELECT site_uid, address_number, street_fullname, town, ST_Y(geom), ST_X(geom)
FROM address_points
WHERE state_abbr = 'ME' AND address_number > 0
  AND coalesce(street_fullname, '') <> '' AND coalesce(town, '') <> ''
ORDER BY md5(site_uid || %(seed)s)
LIMIT %(size)s
"""


def address_line(number, street, town) -> str:
    """The one-line address every geocoder is given, E911-style but in
    title case, with no ZIP (E911 has none; Meridian matches by town)."""
    return f"{number} {street.title()}, {town.title()}, ME"


def draw_sample(dsn, size: int):
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(SAMPLE_SQL, {"seed": SEED, "size": size}).fetchall()
    return [
        {
            "id": site_uid,
            "address": address_line(number, street, town),
            "true_lat": round(lat, 7),
            "true_lon": round(lon, 7),
        }
        for site_uid, number, street, town, lat, lon in rows
    ]


def write_sample(rows, path: Path) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "address", "true_lat", "true_lon"])
        writer.writeheader()
        writer.writerows(rows)


def read_sample(path: Path):
    with path.open(newline="") as f:
        return [
            {**row, "true_lat": float(row["true_lat"]), "true_lon": float(row["true_lon"])}
            for row in csv.DictReader(f)
        ]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn")
    parser.add_argument("--size", type=int, default=300)
    args = parser.parse_args()
    path = DATA_DIR / f"maine_e911_{args.size}.csv"
    if path.exists():
        raise SystemExit(f"{path} already exists -- the sample is fixed on purpose; delete it only to start a new series")
    rows = draw_sample(args.dsn, args.size)
    write_sample(rows, path)
    print(f"Wrote {len(rows)} addresses to {path}")


if __name__ == "__main__":
    main()
