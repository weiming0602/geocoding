"""Populate streets.state and streets.state_abbr from the TIGER/Line
national states shapefile.

Downloads tl_<year>_us_state (one shapefile covering every state, with
STATEFP, NAME, and STUSPS fields) and joins it onto the streets table
by statefp, filling in the full state name and its postal abbreviation.
"""

import argparse
import sqlite3
import urllib.request
import zipfile
from pathlib import Path
from typing import NamedTuple

import shapefile

from .schema import ensure_columns

STATE_SHP_URL_TEMPLATE = (
    "https://www2.census.gov/geo/tiger/TIGER{year}/STATE/tl_{year}_us_state.zip"
)


class StateInfo(NamedTuple):
    name: str
    abbr: str


def _download_and_extract_states_shp(year: int, data_dir: Path) -> Path:
    """Downloads (if not already cached) and extracts the national states
    shapefile, returning the path to the .shp file."""
    zip_name = f"tl_{year}_us_state.zip"
    shp_name = f"tl_{year}_us_state.shp"

    data_dir.mkdir(parents=True, exist_ok=True)
    zip_path = data_dir / zip_name
    shp_path = data_dir / shp_name

    if shp_path.exists():
        return shp_path

    if not zip_path.exists():
        url = STATE_SHP_URL_TEMPLATE.format(year=year)
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, zip_path)

    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(data_dir)

    return shp_path


def _read_state_lookup(shp_path: Path) -> dict[str, StateInfo]:
    """Reads {STATEFP: StateInfo(name, abbr)} out of the national states shapefile."""
    reader = shapefile.Reader(str(shp_path))
    field_names = [f[0] for f in reader.fields[1:]]
    required = {"STATEFP", "NAME", "STUSPS"}
    if not required.issubset(field_names):
        raise ValueError(f"expected {sorted(required)} fields in {shp_path}, found: {field_names}")

    lookup = {}
    for record in reader.iterRecords():
        data = record.as_dict()
        lookup[data["STATEFP"]] = StateInfo(name=data["NAME"], abbr=data["STUSPS"])
    return lookup


def update_state_names(db_path: Path, year: int, data_dir: Path) -> int:
    """Fills in streets.state and streets.state_abbr by joining statefp
    against the national states shapefile. Returns the number of rows updated."""
    shp_path = _download_and_extract_states_shp(year, data_dir)
    state_lookup = _read_state_lookup(shp_path)

    conn = sqlite3.connect(db_path)
    try:
        ensure_columns(conn)

        conn.execute("DROP TABLE IF EXISTS _state_lookup")
        conn.execute(
            "CREATE TEMP TABLE _state_lookup (statefp TEXT PRIMARY KEY, name TEXT, abbr TEXT)"
        )
        conn.executemany(
            "INSERT INTO _state_lookup (statefp, name, abbr) VALUES (?, ?, ?)",
            [(statefp, info.name, info.abbr) for statefp, info in state_lookup.items()],
        )

        cursor = conn.execute(
            """
            UPDATE streets
            SET state = (
                    SELECT name FROM _state_lookup WHERE _state_lookup.statefp = streets.statefp
                ),
                state_abbr = (
                    SELECT abbr FROM _state_lookup WHERE _state_lookup.statefp = streets.statefp
                )
            WHERE EXISTS (
                SELECT 1 FROM _state_lookup WHERE _state_lookup.statefp = streets.statefp
            )
            AND (
                state IS NOT (SELECT name FROM _state_lookup WHERE _state_lookup.statefp = streets.statefp)
                OR state_abbr IS NOT (SELECT abbr FROM _state_lookup WHERE _state_lookup.statefp = streets.statefp)
            )
            """
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Populate streets.state/state_abbr from the TIGER/Line national states shapefile."
    )
    parser.add_argument("database", type=Path, help="Path to the SQLite database")
    parser.add_argument(
        "--year", type=int, default=2024, help="TIGER/Line vintage year (default: 2024)"
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data") / "states",
        help="Directory to cache the downloaded/extracted shapefile in (default: data/states)",
    )
    args = parser.parse_args()

    updated = update_state_names(args.database, args.year, args.data_dir)
    print(f"Updated state/state_abbr on {updated} rows in {args.database}")


if __name__ == "__main__":
    main()
