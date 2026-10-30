"""Load town/city boundaries (TIGER/Line county subdivisions) into `towns`.

One statewide shapefile per state (tl_<year>_<statefp>_cousub). In New
England, county subdivisions are the real towns and cities an address
names ("Lebanon", "Concord"), which is what geocodeMatching.js's
matchByStreetAndTown searches within -- street_names/streets have no town
of their own. Upserted by GEOID, so re-running picks up renamed towns and
redrawn boundaries instead of keeping the first vintage forever.
"""

import argparse
import json
import urllib.request
import zipfile
from pathlib import Path

import psycopg
import shapefile

from .schema import CREATE_TOWNS_INDEXES_SQL, CREATE_TOWNS_TABLE_SQL
from .states import STATES

COUSUB_URL_TEMPLATE = "https://www2.census.gov/geo/tiger/TIGER{year}/COUSUB/tl_{year}_{statefp}_cousub.zip"

# COUSUBFP 00000 is TIGER's "County subdivisions not defined" filler
# (water areas), not a place anyone writes in an address.
UNDEFINED_COUSUBFP = "00000"

UPSERT_SQL = """
INSERT INTO towns (geoid, statefp, countyfp, cousubfp, state, state_abbr, name, namelsad, geom)
VALUES (%(geoid)s, %(statefp)s, %(countyfp)s, %(cousubfp)s, %(state)s, %(state_abbr)s, %(name)s,
        %(namelsad)s, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%(geojson)s), 4326)), 3)))
ON CONFLICT (geoid) DO UPDATE SET
    name = EXCLUDED.name,
    namelsad = EXCLUDED.namelsad,
    state = EXCLUDED.state,
    state_abbr = EXCLUDED.state_abbr,
    geom = EXCLUDED.geom
"""


def _download_and_extract_cousub(statefp: str, year: int, data_dir: Path) -> Path:
    """Downloads (if not already cached) and extracts one state's county
    subdivisions shapefile, returning the path to its .shp."""
    zip_name = f"tl_{year}_{statefp}_cousub.zip"
    shp_path = data_dir / f"tl_{year}_{statefp}_cousub.shp"

    data_dir.mkdir(parents=True, exist_ok=True)
    if shp_path.exists():
        return shp_path

    zip_path = data_dir / zip_name
    if not zip_path.exists():
        url = COUSUB_URL_TEMPLATE.format(year=year, statefp=statefp)
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, zip_path)

    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(data_dir)

    return shp_path


def ingest_towns_shapefile(shp_path: Path, dsn: str, state_abbr: str) -> int:
    """Upserts every defined county subdivision in `shp_path` into towns.
    Returns the number of towns written."""
    state = STATES[state_abbr]
    reader = shapefile.Reader(str(shp_path))
    rows = []
    for shape_record in reader.iterShapeRecords():
        record = shape_record.record.as_dict()
        if record["COUSUBFP"] == UNDEFINED_COUSUBFP:
            continue
        rows.append(
            {
                "geoid": record["GEOID"],
                "statefp": record["STATEFP"],
                "countyfp": record["COUNTYFP"],
                "cousubfp": record["COUSUBFP"],
                "state": state["name"],
                "state_abbr": state_abbr,
                "name": record["NAME"],
                "namelsad": record["NAMELSAD"],
                "geojson": json.dumps(shape_record.shape.__geo_interface__),
            }
        )

    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_TOWNS_TABLE_SQL)
        conn.execute(CREATE_TOWNS_INDEXES_SQL)
        with conn.cursor() as cursor:
            cursor.executemany(UPSERT_SQL, rows)
        conn.commit()
    return len(rows)


def ingest_towns(dsn: str, state_abbr: str, year: int, data_dir: Path) -> int:
    """Downloads one state's town boundaries and upserts them into towns."""
    if state_abbr not in STATES:
        raise ValueError(f"unknown state {state_abbr!r}; known: {sorted(STATES)}")
    shp_path = _download_and_extract_cousub(STATES[state_abbr]["fips"], year, data_dir)
    return ingest_towns_shapefile(shp_path, dsn, state_abbr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("dsn", help="Postgres connection string, e.g. 'dbname=geocoding'")
    parser.add_argument("--states", nargs="+", choices=sorted(STATES), default=sorted(STATES))
    parser.add_argument("--year", type=int, default=2024, help="TIGER/Line vintage year (default: 2024)")
    parser.add_argument(
        "--data-dir", type=Path, default=Path("data"), help="Base directory to cache downloads in (default: data/)"
    )
    args = parser.parse_args()

    for state_abbr in args.states:
        count = ingest_towns(args.dsn, state_abbr, args.year, args.data_dir / state_abbr.lower())
        print(f"{state_abbr}: {count} towns")


if __name__ == "__main__":
    main()
