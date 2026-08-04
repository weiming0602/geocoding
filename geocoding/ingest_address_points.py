"""Ingest Maine's E911 address points (real per-house locations) into Postgres.

Source: Maine Office of GIS's public `Maine_E911_Addresses_Feature`
ArcGIS FeatureServer -- one point per addressable structure statewide,
~798K rows. No equivalent openly-downloadable dataset was found for New
Hampshire (its E911 address data sits with NH's Dept. of Safety /
Emergency Services & Communications and looks like it requires a direct
data-sharing request, not a public API) -- this ingest is Maine-only for
now.

Paginated over the service's REST `query` endpoint (2000 rows/page,
`outSR=4326` so the server reprojects from its native NAD83 UTM 19N to
WGS84 for us -- no local reprojection needed). Keyed by SITE_UID, so
re-running is idempotent (INSERT ... ON CONFLICT DO NOTHING).
"""

import argparse
import json
import time
import urllib.parse
import urllib.request

import psycopg

from .db import insert_ignore_count
from .schema import CREATE_ADDRESS_POINTS_INDEXES_SQL, CREATE_ADDRESS_POINTS_TABLE_SQL

DEFAULT_SERVICE_URL = (
    "https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/"
    "Maine_E911_Addresses_Feature/FeatureServer/0/query"
)
PAGE_SIZE = 2000
OUT_FIELDS = "SITE_UID,ADDRESS_NUMBER,ST_FULLNAME,TOWN,COUNTY,STATE"

INSERT_SQL = """
INSERT INTO address_points
    (site_uid, address_number, street_fullname, town, county, state_abbr, geom)
VALUES (%(site_uid)s, %(address_number)s, %(street_fullname)s, %(town)s, %(county)s,
        %(state_abbr)s, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326))
ON CONFLICT (site_uid) DO NOTHING
RETURNING id
"""


def _fetch_page(service_url, where, offset):
    params = {
        "where": where,
        "outFields": OUT_FIELDS,
        "outSR": "4326",
        "f": "json",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
    }
    url = f"{service_url}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def _rows_from_page(page):
    rows = []
    for feature in page.get("features", []):
        attrs = feature["attributes"]
        geom = feature.get("geometry")
        if not geom:
            continue
        rows.append(
            {
                "site_uid": attrs.get("SITE_UID"),
                "address_number": attrs.get("ADDRESS_NUMBER"),
                "street_fullname": attrs.get("ST_FULLNAME"),
                "town": attrs.get("TOWN"),
                "county": attrs.get("COUNTY"),
                "state_abbr": attrs.get("STATE"),
                "lon": geom["x"],
                "lat": geom["y"],
            }
        )
    return rows


def ingest_address_points(dsn, where="1=1", service_url=DEFAULT_SERVICE_URL):
    """Ingests every address point matching `where` (an ArcGIS SQL-like
    filter, e.g. "TOWN='Brunswick'") into the address_points table.
    Returns the number of rows newly inserted."""
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_ADDRESS_POINTS_TABLE_SQL)
        conn.execute(CREATE_ADDRESS_POINTS_INDEXES_SQL)

        total_inserted = 0
        offset = 0
        while True:
            page = _fetch_page(service_url, where, offset)
            if "error" in page:
                raise RuntimeError(f"ArcGIS query failed: {page['error']}")

            rows = _rows_from_page(page)
            if not rows:
                break

            total_inserted += insert_ignore_count(conn, INSERT_SQL, rows)
            conn.commit()

            offset += PAGE_SIZE
            if not page.get("exceededTransferLimit") and len(rows) < PAGE_SIZE:
                break
            time.sleep(0.1)  # be polite to a free public service

        return total_inserted


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dsn", help="Postgres connection string, e.g. 'dbname=geocoding'")
    parser.add_argument(
        "--where",
        default="1=1",
        help="ArcGIS SQL filter, e.g. \"TOWN='Brunswick'\" (default: all of Maine)",
    )
    parser.add_argument("--service-url", default=DEFAULT_SERVICE_URL)
    args = parser.parse_args()

    count = ingest_address_points(args.dsn, args.where, args.service_url)
    print(f"Inserted {count} new address points")


if __name__ == "__main__":
    main()
