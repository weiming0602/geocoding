from unittest.mock import patch

import psycopg
import shapefile

from geocoding.ingest_towns import _download_and_extract_cousub, ingest_towns_shapefile


def _write_cousub_shapefile(base_path, towns):
    """towns: list of (cousubfp, name, ring) -- ring is a closed list of (lon, lat)."""
    writer = shapefile.Writer(str(base_path), shapeType=shapefile.POLYGON)
    for field in ("STATEFP", "COUNTYFP", "COUSUBFP", "GEOID", "NAME", "NAMELSAD"):
        writer.field(field, "C")
    for cousubfp, name, ring in towns:
        writer.poly([ring])
        writer.record("33", "009", cousubfp, f"33009{cousubfp}", name, f"{name} city")
    writer.close()


SQUARE = [(-72.3, 43.6), (-72.2, 43.6), (-72.2, 43.7), (-72.3, 43.7), (-72.3, 43.6)]
OTHER_SQUARE = [(-71.6, 43.1), (-71.5, 43.1), (-71.5, 43.2), (-71.6, 43.2), (-71.6, 43.1)]


def test_ingest_towns_shapefile_loads_named_towns_and_skips_undefined(dsn, tmp_path):
    base = tmp_path / "cousub"
    _write_cousub_shapefile(
        base, [("41300", "Lebanon", SQUARE), ("00000", "County subdivisions not defined", OTHER_SQUARE)]
    )

    count = ingest_towns_shapefile(base.with_suffix(".shp"), dsn, "NH")

    assert count == 1
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT geoid, name, namelsad, state, state_abbr, GeometryType(geom),"
            " ST_Contains(geom, ST_SetSRID(ST_MakePoint(-72.25, 43.65), 4326)) FROM towns"
        ).fetchall()
    assert rows == [("3300941300", "Lebanon", "Lebanon city", "New Hampshire", "NH", "MULTIPOLYGON", True)]


def test_ingest_towns_shapefile_upserts_by_geoid(dsn, tmp_path):
    first = tmp_path / "v1"
    _write_cousub_shapefile(first, [("41300", "Lebanon", SQUARE)])
    ingest_towns_shapefile(first.with_suffix(".shp"), dsn, "NH")

    second = tmp_path / "v2"
    _write_cousub_shapefile(second, [("41300", "Lebanon Renamed", OTHER_SQUARE)])
    ingest_towns_shapefile(second.with_suffix(".shp"), dsn, "NH")

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT name, ST_Contains(geom, ST_SetSRID(ST_MakePoint(-71.55, 43.15), 4326)) FROM towns"
        ).fetchall()
    assert rows == [("Lebanon Renamed", True)]


def test_download_and_extract_cousub_skips_download_if_cached(tmp_path):
    shp_path = tmp_path / "tl_2024_33_cousub.shp"
    shp_path.write_text("already here")

    with patch("geocoding.ingest_towns.urllib.request.urlretrieve") as mock_urlretrieve:
        result = _download_and_extract_cousub("33", 2024, tmp_path)

    mock_urlretrieve.assert_not_called()
    assert result == shp_path
