from unittest.mock import patch

import shapefile

from geocoding.states import STATES
from geocoding.update_state import _download_and_extract, update_state


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


def test_states_registry_has_maine_and_new_hampshire():
    assert STATES["ME"]["fips"] == "23"
    assert len(STATES["ME"]["counties"]) == 16
    assert STATES["ME"]["counties"]["005"] == "Cumberland"

    assert STATES["NH"]["fips"] == "33"
    assert len(STATES["NH"]["counties"]) == 10
    assert STATES["NH"]["counties"]["011"] == "Hillsborough"

    for abbr, state in STATES.items():
        assert all(len(code) == 3 and code.isdigit() for code in state["counties"]), abbr


def test_download_and_extract_skips_download_if_shp_already_present(tmp_path):
    shp_path = tmp_path / "tl_2024_33011_edges.shp"
    shp_path.write_text("already here")

    with patch("geocoding.update_state.urllib.request.urlretrieve") as mock_urlretrieve:
        result = _download_and_extract("33", "011", 2024, tmp_path)

    mock_urlretrieve.assert_not_called()
    assert result == shp_path


def test_download_and_extract_downloads_when_nothing_cached(tmp_path):
    import zipfile as zipfile_module

    shapefile_base = tmp_path / "source"
    _write_sample_shapefile(shapefile_base)

    def fake_urlretrieve(url, dest):
        with zipfile_module.ZipFile(dest, "w") as zf:
            for ext in (".shp", ".shx", ".dbf"):
                zf.write(shapefile_base.with_suffix(ext), f"tl_2024_33011_edges{ext}")

    with patch(
        "geocoding.update_state.urllib.request.urlretrieve", side_effect=fake_urlretrieve
    ) as mock_urlretrieve:
        result = _download_and_extract("33", "011", 2024, tmp_path)

    mock_urlretrieve.assert_called_once()
    assert "tl_2024_33011_edges.zip" in mock_urlretrieve.call_args[0][0]
    assert result == tmp_path / "tl_2024_33011_edges.shp"
    assert result.exists()


def test_update_state_rejects_unknown_state(tmp_path):
    import pytest

    with pytest.raises(ValueError, match="unknown state"):
        update_state("ZZ", tmp_path / "db.sqlite", 2024, tmp_path / "cache")


def test_update_state_ingests_every_county_without_network(tmp_path):
    shapefile_base = tmp_path / "source"
    _write_sample_shapefile(shapefile_base)
    shp_path = shapefile_base.with_suffix(".shp")

    db_path = tmp_path / "streets.db"

    with patch(
        "geocoding.update_state._download_and_extract", return_value=shp_path
    ) as mock_download:
        update_state("NH", db_path, 2024, tmp_path / "cache")

    assert mock_download.call_count == len(STATES["NH"]["counties"])

    import sqlite3

    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM streets").fetchone()[0]
    conn.close()
    # Every county "download" points at the same TLID 999, so only the
    # first ingest inserts it — later ones are deduped.
    assert count == 1
