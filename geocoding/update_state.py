"""Update the streets table from TIGER/Line edges for every county in a state.

Downloads (if not already cached on disk) the TIGER/Line edges
shapefile for each county in the given state and ingests it into the
target SQLite database. Ingestion is keyed by TLID (see
geocoding.ingest), so re-running this script only inserts rows that
don't already exist — safe to run repeatedly, e.g. to pick up a new
TIGER vintage, resume an interrupted run, or add another state to a
database that already has others.
"""

import argparse
import urllib.request
import zipfile
from pathlib import Path

from .ingest import ingest
from .states import STATES

TIGER_EDGES_URL_TEMPLATE = (
    "https://www2.census.gov/geo/tiger/TIGER{year}/EDGES/tl_{year}_{statecounty}_edges.zip"
)


def _download_and_extract(state_fips: str, county_fips: str, year: int, data_dir: Path) -> Path:
    """Downloads (if not already cached) and extracts one county's edges
    shapefile, returning the path to the .shp file."""
    statecounty = f"{state_fips}{county_fips}"
    zip_name = f"tl_{year}_{statecounty}_edges.zip"
    shp_name = f"tl_{year}_{statecounty}_edges.shp"

    data_dir.mkdir(parents=True, exist_ok=True)
    zip_path = data_dir / zip_name
    shp_path = data_dir / shp_name

    if shp_path.exists():
        return shp_path

    if not zip_path.exists():
        url = TIGER_EDGES_URL_TEMPLATE.format(year=year, statecounty=statecounty)
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, zip_path)

    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(data_dir)

    return shp_path


def update_state(state_abbr: str, db_path: Path, year: int, data_dir: Path) -> None:
    """Ingests every county's TIGER/Line edges for one state into db_path."""
    if state_abbr not in STATES:
        raise ValueError(f"unknown state {state_abbr!r}; known: {sorted(STATES)}")

    state = STATES[state_abbr]
    for county_fips, county_name in state["counties"].items():
        shp_path = _download_and_extract(state["fips"], county_fips, year, data_dir)
        inserted = ingest(shp_path, db_path)
        print(f"{county_name} County ({state['fips']}{county_fips}): {inserted} new rows")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update the streets table from TIGER/Line edges for every county in a state."
    )
    parser.add_argument("database", type=Path, help="Path to the SQLite database")
    parser.add_argument(
        "--state", required=True, choices=sorted(STATES), help="State postal abbreviation"
    )
    parser.add_argument(
        "--year", type=int, default=2024, help="TIGER/Line vintage year (default: 2024)"
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="Directory to cache downloaded/extracted shapefiles in (default: data/<state>)",
    )
    args = parser.parse_args()

    data_dir = args.data_dir or Path("data") / args.state.lower()
    update_state(args.state, args.database, args.year, data_dir)


if __name__ == "__main__":
    main()
