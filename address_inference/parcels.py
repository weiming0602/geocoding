"""Tax parcels: which lot each building is on, and which streets each lot fronts.

    python -m address_inference.parcels "dbname=geocoding" me --town Freeport

A building belongs to the street its lot fronts, even when another road is
nearer: 15 Summer Street's back building sits closer to Village View Lane,
but its parcel (9/8/0/0, "15 SUMMER STREET") fronts Summer Street. And the
buildings on one parcel are one property (a house and its barn), and a
complex's parcel ("2 VILLAGE VIEW", 22,703 m2) holds all its units.

Source: Maine GeoLibrary "Maine Parcels Organized Towns" (Access: Public.
Use: User assumes risk) -- towns submit voluntarily, so coverage and
currency vary (Freeport: 4,356 parcels, 2022). See DATA_SOURCES.md.

Only the lot GEOMETRY feeds the model here. The assessor's address on each
lot (PROP_LOC) is stored but not used: it nearly answers the question, so
it gets its own, separately scored mode.

Writes, per database (frontage is measured against that database's own
`streets`, TIGER or otherwise):
  address_inference.parcels           the lots (shared source data)
  address_inference.building_parcels  building -> parcel (inner point inside)
  address_inference.parcel_frontage   parcel x street segment: meters of the
                                      segment within FRONTAGE_BUFFER_M of the lot
"""

import argparse
import json
import time
import urllib.parse
import urllib.request

import psycopg

from .regions import load_region

LAYER = ("https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/"
         "Maine_Parcels_Organized_Towns/FeatureServer/10/query")
SOURCE = "maine_parcels_organized_towns"
CHUNK = 200
FRONTAGE_BUFFER_M = 15

CREATE_SQL = """
CREATE SCHEMA IF NOT EXISTS address_inference;
CREATE TABLE IF NOT EXISTS address_inference.parcels (
    state_fips TEXT NOT NULL,
    source TEXT NOT NULL,
    parcel_id TEXT NOT NULL,
    town TEXT,
    map_bk_lot TEXT,
    prop_loc TEXT,
    prop_num INTEGER,
    updated TEXT,
    geom geometry(MultiPolygon, 4326) NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (state_fips, source, parcel_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_parcels_geom ON address_inference.parcels USING GIST (geom);
CREATE TABLE IF NOT EXISTS address_inference.building_parcels (
    state_fips TEXT NOT NULL,
    source_id TEXT NOT NULL,
    parcel_id TEXT NOT NULL,
    PRIMARY KEY (state_fips, source_id)
);
CREATE TABLE IF NOT EXISTS address_inference.parcel_frontage (
    parcel_id TEXT NOT NULL,
    tlid TEXT NOT NULL,
    frontage_m DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (parcel_id, tlid)
);
"""

UPSERT_SQL = """
INSERT INTO address_inference.parcels
  (state_fips, source, parcel_id, town, map_bk_lot, prop_loc, prop_num, updated, geom)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))))
ON CONFLICT (state_fips, source, parcel_id) DO UPDATE SET
  town = EXCLUDED.town, map_bk_lot = EXCLUDED.map_bk_lot, prop_loc = EXCLUDED.prop_loc,
  prop_num = EXCLUDED.prop_num, updated = EXCLUDED.updated, geom = EXCLUDED.geom, loaded_at = now()
"""

# Each building in the town's parcels -> the parcel holding its inner point.
BUILDING_PARCELS_SQL = """
DELETE FROM address_inference.building_parcels bp
USING address_inference.parcels p
WHERE p.town = %(town)s AND p.state_fips = %(state_fips)s AND bp.parcel_id = p.parcel_id;
INSERT INTO address_inference.building_parcels (state_fips, source_id, parcel_id)
SELECT DISTINCT ON (s.source_id) s.state_fips, s.source_id, p.parcel_id
FROM address_inference.parcels p
JOIN address_inference.structures s
  ON s.state_fips = p.state_fips AND s.inner_point && p.geom AND ST_Intersects(p.geom, s.inner_point)
WHERE p.town = %(town)s AND p.state_fips = %(state_fips)s
ORDER BY s.source_id, ST_Area(p.geom)
ON CONFLICT (state_fips, source_id) DO UPDATE SET parcel_id = EXCLUDED.parcel_id;
"""

# Meters of each nearby street segment running within the buffer of a lot.
FRONTAGE_SQL = f"""
DELETE FROM address_inference.parcel_frontage pf
USING address_inference.parcels p
WHERE p.town = %(town)s AND p.state_fips = %(state_fips)s AND pf.parcel_id = p.parcel_id;
INSERT INTO address_inference.parcel_frontage (parcel_id, tlid, frontage_m)
SELECT p.parcel_id, st.tlid,
       ST_Length(ST_Intersection(st.geom, ST_Buffer(p.geom::geography, {FRONTAGE_BUFFER_M})::geometry)::geography)
FROM address_inference.parcels p
JOIN streets st ON st.geom && ST_Expand(p.geom, 0.0003)
 AND ST_DWithin(st.geom::geography, p.geom::geography, {FRONTAGE_BUFFER_M})
WHERE p.town = %(town)s AND p.state_fips = %(state_fips)s
ON CONFLICT (parcel_id, tlid) DO NOTHING;
DELETE FROM address_inference.parcel_frontage WHERE frontage_m < 1;
"""


def _post(params, attempts=4):
    data = urllib.parse.urlencode(params).encode()
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(LAYER, data=data, headers={"User-Agent": "MeridianGeocoding/1.0"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = json.load(resp)
            if "error" in body:
                raise RuntimeError(body["error"])
            return body
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)


def fetch(town):
    where = "TOWN = '" + town.replace("'", "''") + "'"
    ids = sorted(_post({"where": where, "returnIdsOnly": "true", "f": "json"}).get("objectIds") or [])
    print(f"{len(ids)} parcels to download")
    features = []
    for i in range(0, len(ids), CHUNK):
        page = _post({"objectIds": ",".join(map(str, ids[i:i + CHUNK])), "returnGeometry": "true", "outSR": "4326",
                      "outFields": "GlobalID,STATE_ID,TOWN,MAP_BK_LOT,PROP_LOC,PROPLOCNUM,FMUPDAT", "f": "geojson"})
        features += page.get("features", [])
    return features


def rows(features, state_fips):
    for f in features:
        p, geom = f.get("properties") or {}, f.get("geometry")
        if not geom:
            continue
        pid = p.get("GlobalID") or p.get("STATE_ID")
        num = p.get("PROPLOCNUM")
        yield (state_fips, SOURCE, pid, p.get("TOWN"), p.get("MAP_BK_LOT"), (p.get("PROP_LOC") or "").strip() or None,
               int(num) if isinstance(num, (int, float)) else None, str(p.get("FMUPDAT") or "") or None,
               json.dumps(geom))


def load(dsn, region, town, download=True):
    params = {"town": town, "state_fips": region.state_fips}
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_SQL)
        if download:
            batch = list(rows(fetch(town), region.state_fips))
            with conn.cursor() as cur:
                cur.executemany(UPSERT_SQL, batch)
        for script in (BUILDING_PARCELS_SQL, FRONTAGE_SQL):
            for statement in filter(str.strip, script.split(";")):
                conn.execute(statement, params if "%(" in statement else None)
        counts = conn.execute("""
            SELECT (SELECT count(*) FROM address_inference.parcels WHERE town = %(town)s AND state_fips = %(state_fips)s),
                   (SELECT count(*) FROM address_inference.building_parcels bp JOIN address_inference.parcels p USING (parcel_id)
                     WHERE p.town = %(town)s),
                   (SELECT count(DISTINCT pf.parcel_id) FROM address_inference.parcel_frontage pf
                     JOIN address_inference.parcels p USING (parcel_id) WHERE p.town = %(town)s)""", params).fetchone()
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn")
    parser.add_argument("region")
    parser.add_argument("--town", required=True)
    parser.add_argument("--no-download", action="store_true",
                        help="reuse parcels already in this database; only redo building links and frontage")
    args = parser.parse_args()
    region = load_region(args.region)
    if region.id != "me":
        raise SystemExit("only Maine's statewide parcel layer is wired up")
    parcels, linked, fronting = load(args.dsn, region, args.town, download=not args.no_download)
    print(f"{args.town}: {parcels} parcels, {linked} buildings on a parcel, {fronting} parcels front a street segment")


if __name__ == "__main__":
    main()
