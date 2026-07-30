import zipfile
from unittest.mock import patch

import shapefile

from geocoding.update_maine import (
    MAINE_COUNTY_FIPS,
    MAINE_STATE_FIPS,
    _download_and_extract,
    update_maine,
)


def _write_sample_shapefile(base_path):
    writer = shapefile.Writer(str(base_path), shapeType=shapefile.POLYLINE)
    writer.field("TLID", "C")
    writer.field("FULLNAME", "C")
    writer.field("LFROMADD", "C")
    writer.field("LTOADD", "C")
    writer.field("RFROMADD", "C")
    writer.field("RTOADD", "C")
    writer.field("ZIPL", "C")
    writer.field("ZIPR", "C")
    writer.field("MTFCC", "C")
    writer.field("STATEFP", "C")
    writer.field("COUNTYFP", "C")
    writer.line([[(-70.5, 43.5), (-70.4, 43.6)]])
    writer.record("999", "Test Rd", "1", "99", "2", "98", "04000", "04000", "S1400", "23", "005")
    writer.close()


def test_maine_county_fips_covers_all_16_counties():
    assert MAINE_STATE_FIPS == "23"
    assert len(MAINE_COUNTY_FIPS) == 16
    assert MAINE_COUNTY_FIPS["005"] == "Cumberland"
    assert MAINE_COUNTY_FIPS["031"] == "York"
    # All codes are 3-digit numeric strings, as FIPS codes should be.
    assert all(len(code) == 3 and code.isdigit() for code in MAINE_COUNTY_FIPS)


def test_download_and_extract_skips_download_if_shp_already_present(tmp_path):
    shp_path = tmp_path / "tl_2024_23005_edges.shp"
    shp_path.write_text("already here")

    with patch("geocoding.update_maine.urllib.request.urlretrieve") as mock_urlretrieve:
        result = _download_and_extract("005", 2024, tmp_path)

    mock_urlretrieve.assert_not_called()
    assert result == shp_path


def test_download_and_extract_skips_download_if_zip_already_cached(tmp_path):
    shapefile_base = tmp_path / "source"
    _write_sample_shapefile(shapefile_base)

    zip_path = tmp_path / "tl_2024_23005_edges.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for ext in (".shp", ".shx", ".dbf"):
            zf.write(shapefile_base.with_suffix(ext), f"tl_2024_23005_edges{ext}")

    with patch("geocoding.update_maine.urllib.request.urlretrieve") as mock_urlretrieve:
        result = _download_and_extract("005", 2024, tmp_path)

    mock_urlretrieve.assert_not_called()
    assert result == tmp_path / "tl_2024_23005_edges.shp"
    assert result.exists()


def test_download_and_extract_downloads_when_nothing_cached(tmp_path):
    shapefile_base = tmp_path / "source"
    _write_sample_shapefile(shapefile_base)

    def fake_urlretrieve(url, dest):
        with zipfile.ZipFile(dest, "w") as zf:
            for ext in (".shp", ".shx", ".dbf"):
                zf.write(shapefile_base.with_suffix(ext), f"tl_2024_23005_edges{ext}")

    with patch(
        "geocoding.update_maine.urllib.request.urlretrieve", side_effect=fake_urlretrieve
    ) as mock_urlretrieve:
        result = _download_and_extract("005", 2024, tmp_path)

    mock_urlretrieve.assert_called_once()
    assert "tl_2024_23005_edges.zip" in mock_urlretrieve.call_args[0][0]
    assert result == tmp_path / "tl_2024_23005_edges.shp"
    assert result.exists()


def test_update_maine_ingests_every_county_without_network(tmp_path):
    shapefile_base = tmp_path / "source"
    _write_sample_shapefile(shapefile_base)
    shp_path = shapefile_base.with_suffix(".shp")

    db_path = tmp_path / "streets.db"

    with patch(
        "geocoding.update_maine._download_and_extract", return_value=shp_path
    ) as mock_download:
        update_maine(db_path, 2024, tmp_path / "cache")

    assert mock_download.call_count == len(MAINE_COUNTY_FIPS)

    import sqlite3

    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM streets").fetchone()[0]
    conn.close()
    # Every county "download" points at the same TLID 999, so only the
    # first ingest inserts it — later ones are deduped.
    assert count == 1
