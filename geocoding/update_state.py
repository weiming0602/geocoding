"""Update the streets table from TIGER/Line edges for every county in a state.

Downloads (if not already cached on disk) the TIGER/Line edges and
featnames files for each county in the given state and ingests them
into the target Postgres database. Ingestion is keyed by TLID (see
geocoding.ingest / geocoding.ingest_featnames), so re-running this
script only inserts rows that don't already exist — safe to run
repeatedly, e.g. to pick up a new TIGER vintage, resume an interrupted
run, or add another state to a database that already has others.
"""

import argparse
import urllib.request
import zipfile
from pathlib import Path

from .ingest import ingest
from .ingest_featnames import ingest_featnames
from .states import STATES

TIGER_URL_TEMPLATE = (
    "https://www2.census.gov/geo/tiger/TIGER{year}/{layer_dir}/tl_{year}_{statecounty}_{layer}.zip"
)


def _download_and_extract(
    state_fips: str, county_fips: str, year: int, data_dir: Path, *, layer: str, layer_dir: str, primary_ext: str
) -> Path:
    """Downloads (if not already cached) and extracts one county's TIGER/Line
    layer, returning the path to its primary file (.shp for edges, .dbf for
    featnames, which has no geometry)."""
    statecounty = f"{state_fips}{county_fips}"
    zip_name = f"tl_{year}_{statecounty}_{layer}.zip"
    primary_name = f"tl_{year}_{statecounty}_{layer}.{primary_ext}"

    data_dir.mkdir(parents=True, exist_ok=True)
    zip_path = data_dir / zip_name
    primary_path = data_dir / primary_name

    if primary_path.exists():
        return primary_path

    if not zip_path.exists():
        url = TIGER_URL_TEMPLATE.format(year=year, layer_dir=layer_dir, statecounty=statecounty, layer=layer)
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, zip_path)

    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(data_dir)

    return primary_path


def update_state(state_abbr: str, dsn: str, year: int, data_dir: Path) -> None:
    """Ingests every county's TIGER/Line edges + featnames for one state into
    the Postgres database at dsn."""
    if state_abbr not in STATES:
        raise ValueError(f"unknown state {state_abbr!r}; known: {sorted(STATES)}")

    state = STATES[state_abbr]
    for county_fips, county_name in state["counties"].items():
        shp_path = _download_and_extract(
            state["fips"], county_fips, year, data_dir, layer="edges", layer_dir="EDGES", primary_ext="shp"
        )
        inserted = ingest(shp_path, dsn)

        dbf_path = _download_and_extract(
            state["fips"], county_fips, year, data_dir,
            layer="featnames", layer_dir="FEATNAMES", primary_ext="dbf",
        )
        names_inserted = ingest_featnames(dbf_path, dsn)

        print(
            f"{county_name} County ({state['fips']}{county_fips}): "
            f"{inserted} new street rows, {names_inserted} new name rows"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update the streets table from TIGER/Line edges for every county in a state."
    )
    parser.add_argument("dsn", help="Postgres connection string, e.g. 'dbname=geocoding'")
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
    update_state(args.state, args.dsn, args.year, data_dir)


if __name__ == "__main__":
    main()
