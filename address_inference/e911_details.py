"""Unit and placement details for Maine E911 address points.

    python -m address_inference.e911_details "dbname=geocoding" me --town Freeport

geocoding.ingest_address_points keeps only number/street/town/geometry.
Two more fields matter for the building experiment:
  unit       "Unit 14" -- one street number can be a whole complex (2 Village
             View: Units 1-31 over ~8 buildings); the unit says which building.
  placement  how the state placed the point: "Structure - Rooftop" sits on the
             building; "Geocoding" was estimated along the road (Somerset
             Condos) and isn't a building at all.
Same public layer as the address points (Maine E911 Addresses Feature,
"Access: Public. Use: No restrictions").
"""

import argparse
import json
import time
import urllib.parse
import urllib.request

import psycopg

from geocoding.ingest_address_points import DEFAULT_SERVICE_URL

from .regions import load_region

CHUNK = 500

CREATE_SQL = """
CREATE SCHEMA IF NOT EXISTS address_inference;
CREATE TABLE IF NOT EXISTS address_inference.e911_point_details (
    site_uid TEXT PRIMARY KEY,
    town TEXT,
    unit TEXT,
    placement TEXT,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_e911_point_details_town ON address_inference.e911_point_details (town);
"""

UPSERT_SQL = """
INSERT INTO address_inference.e911_point_details (site_uid, town, unit, placement)
VALUES (%s, %s, %s, %s)
ON CONFLICT (site_uid) DO UPDATE SET town = EXCLUDED.town, unit = EXCLUDED.unit,
    placement = EXCLUDED.placement, loaded_at = now()
"""


def _post(params, attempts=4):
    data = urllib.parse.urlencode({**params, "f": "json"}).encode()
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(DEFAULT_SERVICE_URL, data=data,
                                         headers={"User-Agent": "MeridianGeocoding/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.load(resp)
            if "error" in body:
                raise RuntimeError(body["error"])
            return body
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)


def unit_label(attrs) -> str | None:
    """'Unit 14' from UNIT, else UNITPRETYP + UNITVALUE; None if no unit."""
    unit = (attrs.get("UNIT") or "").strip()
    if unit:
        return " ".join(unit.split())
    parts = [(attrs.get("UNITPRETYP") or "").strip(), (attrs.get("UNITVALUE") or "").strip()]
    label = " ".join(p for p in parts if p)
    return label or None


def fetch(town):
    where = "TOWN = '" + town.replace("'", "''") + "'"
    ids = sorted(_post({"where": where, "returnIdsOnly": "true"}).get("objectIds") or [])
    rows = []
    for i in range(0, len(ids), CHUNK):
        page = _post({"objectIds": ",".join(map(str, ids[i:i + CHUNK])), "returnGeometry": "false",
                      "outFields": "SITE_UID,TOWN,UNIT,UNITPRETYP,UNITVALUE,PLACEMENT"})
        for f in page.get("features", []):
            a = f["attributes"]
            if a.get("SITE_UID"):
                rows.append((a["SITE_UID"], a.get("TOWN"), unit_label(a), (a.get("PLACEMENT") or "").strip() or None))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn")
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    args = parser.parse_args()
    if load_region(args.region).id != "me":
        raise SystemExit("E911 point details exist for Maine only")
    rows = fetch(args.town)
    with psycopg.connect(args.dsn) as conn:
        conn.execute(CREATE_SQL)
        with conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, rows)
    units = sum(1 for r in rows if r[2])
    print(f"{args.town}: {len(rows)} points, {units} with a unit")


if __name__ == "__main__":
    main()
