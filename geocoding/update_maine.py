"""Update the streets table from TIGER/Line edges for every Maine county.

Downloads (if not already cached on disk) the TIGER/Line edges
shapefile for each of Maine's 16 counties and ingests it into the
target SQLite database. Ingestion is keyed by TLID (see
geocoding.ingest), so re-running this script only inserts rows that
don't already exist — safe to run repeatedly, e.g. to pick up a new
TIGER vintage or resume an interrupted run.
"""

import argparse
import urllib.request
import zipfile
from pathlib import Path

from .ingest import ingest

MAINE_STATE_FIPS = "23"

# Maine's 16 counties, by FIPS code.
MAINE_COUNTY_FIPS = {
    "001": "Androscoggin",
    "003": "Aroostook",
    "005": "Cumberland",
    "007": "Franklin",
    "009": "Hancock",
    "011": "Kennebec",
    "013": "Knox",
    "015": "Lincoln",
    "017": "Oxford",
    "019": "Penobscot",
    "021": "Piscataquis",
    "023": "Sagadahoc",
    "025": "Somerset",
    "027": "Waldo",
    "029": "Washington",
    "031": "York",
}

TIGER_EDGES_URL_TEMPLATE = (
    "https://www2.census.gov/geo/tiger/TIGER{year}/EDGES/tl_{year}_{statecounty}_edges.zip"
)


def _download_and_extract(county_fips: str, year: int, data_dir: Path) -> Path:
    """Downloads (if not already cached) and extracts one county's edges
    shapefile, returning the path to the .shp file."""
    statecounty = f"{MAINE_STATE_FIPS}{county_fips}"
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


def update_maine(db_path: Path, year: int, data_dir: Path) -> None:
    """Ingests every Maine county's TIGER/Line edges into db_path."""
    for county_fips, county_name in MAINE_COUNTY_FIPS.items():
        shp_path = _download_and_extract(county_fips, year, data_dir)
        inserted = ingest(shp_path, db_path)
        print(f"{county_name} County ({MAINE_STATE_FIPS}{county_fips}): {inserted} new rows")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update the streets table from TIGER/Line edges for all of Maine."
    )
    parser.add_argument("database", type=Path, help="Path to the SQLite database")
    parser.add_argument(
        "--year", type=int, default=2024, help="TIGER/Line vintage year (default: 2024)"
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data") / "maine",
        help="Directory to cache downloaded/extracted shapefiles in (default: data/maine)",
    )
    args = parser.parse_args()

    update_maine(args.database, args.year, args.data_dir)


if __name__ == "__main__":
    main()
