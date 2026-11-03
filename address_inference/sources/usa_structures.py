"""Footprint adapter: FEMA/ORNL USA Structures.

Every structure > 450 sq ft in the US, as polygons with an occupancy
class, derived by ORNL from satellite imagery. Served by Esri's hosted
copy (item 0ec8512ad21e4bb987d7e848d14e7e24, owner Esri_US_Federal_Data).

License: CC BY 4.0 (per that item's licenseInfo, checked 2026-11-02),
attribution "Oak Ridge National Laboratory (ORNL); Federal Emergency
Management Agency (FEMA) Geospatial Response Office". Not public domain,
unlike TIGER: anything shipped from it needs that attribution.

Deliberately NOT stored: PROP_ADDR / PROP_CITY / PROP_ST / PROP_ZIP /
PROP_CNTY. They're parcel-derived addresses -- the very thing this
project predicts and scores, so keeping them would leak the answer --
and their own redistribution terms are unclear. POP_* (population
estimates) and the rest are just not needed.

Paging: this service rejects resultOffset/resultRecordCount paging
("Invalid query parameters"), so it's done by object ID instead -- one
returnIdsOnly query, then fetches of ID_CHUNK ids at a time. GeoJSON
output, so the server builds valid polygons (ring order/holes) and we
don't have to interpret Esri rings ourselves.
"""

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SOURCE = "usa_structures"
DEFAULT_SERVICE_URL = (
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
    "USA_Structures_View/FeatureServer/0/query"
)
OUT_FIELDS = "UUID,BUILD_ID,STATE_FIPS,FIPS,OCC_CLS,PRIM_OCC,OUTBLDG,SQMETERS,VAL_METHOD,IMAGE_DATE,PROD_DATE"
ID_CHUNK = 500
MAX_ATTEMPTS = 3


def post_json(url: str, params: dict, timeout: float = 60) -> dict:
    """POSTs form params and returns parsed JSON, retrying transient
    failures. ArcGIS reports query errors as HTTP 200 + {"error": ...},
    which is raised here rather than retried (it won't fix itself)."""
    body = urllib.parse.urlencode(params).encode()
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            request = urllib.request.Request(url, data=body, headers={"User-Agent": "meridian-address-inference"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.load(response)
            break
        except (OSError, json.JSONDecodeError):
            if attempt == MAX_ATTEMPTS:
                raise
            time.sleep(2 * attempt)
    if "error" in data:
        raise RuntimeError(f"ArcGIS query failed: {data['error']}")
    return data


def _epoch_ms_to_date(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date()


def normalize_feature(feature: dict) -> dict | None:
    """One GeoJSON feature -> one structures row (dict), or None if it has
    no usable geometry/ID. Only the fields listed here ever leave this
    function, which is what keeps PROP_* out of the database."""
    geometry = feature.get("geometry")
    if not geometry or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        return None
    props = feature.get("properties") or {}

    source_id = (props.get("UUID") or "").strip("{}").lower()
    if not source_id and props.get("BUILD_ID") is not None:
        source_id = f"build_id:{props['BUILD_ID']}"
    if not source_id:
        return None

    return {
        "state_fips": props.get("STATE_FIPS"),
        "county_fips": props.get("FIPS"),
        "source": SOURCE,
        "source_id": source_id,
        "occ_cls": props.get("OCC_CLS"),
        "prim_occ": props.get("PRIM_OCC"),
        "outbldg": props.get("OUTBLDG"),
        "sqmeters": props.get("SQMETERS"),
        "val_method": props.get("VAL_METHOD"),
        "image_date": _epoch_ms_to_date(props.get("IMAGE_DATE")),
        "prod_date": _epoch_ms_to_date(props.get("PROD_DATE")),
        "geometry": json.dumps(geometry),
    }


class UsaStructures:
    def __init__(self, service_url: str = DEFAULT_SERVICE_URL, post=post_json, pause_seconds: float = 0.2):
        self.service_url = service_url
        self.post = post
        self.pause_seconds = pause_seconds

    def object_ids(self, where: str, envelope=None) -> list[int]:
        """IDs of every structure matching `where` (ArcGIS SQL), optionally
        limited to an (xmin, ymin, xmax, ymax) WGS84 envelope."""
        params = {"where": where, "returnIdsOnly": "true", "f": "json"}
        if envelope is not None:
            params.update(
                geometry=",".join(str(v) for v in envelope),
                geometryType="esriGeometryEnvelope",
                inSR="4326",
                spatialRel="esriSpatialRelIntersects",
            )
        data = self.post(self.service_url, params)
        return sorted(data.get("objectIds") or [])

    def fetch(self, object_ids: list[int]):
        """Yields lists of normalized rows, one list per ID_CHUNK request."""
        for start in range(0, len(object_ids), ID_CHUNK):
            chunk = object_ids[start : start + ID_CHUNK]
            data = self.post(
                self.service_url,
                {
                    "objectIds": ",".join(str(i) for i in chunk),
                    "outFields": OUT_FIELDS,
                    "outSR": "4326",
                    "f": "geojson",
                },
            )
            rows = [row for row in (normalize_feature(f) for f in data.get("features", [])) if row]
            yield rows
            if self.pause_seconds:
                time.sleep(self.pause_seconds)  # be polite to a free public service
