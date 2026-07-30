import sqlite3
import zipfile
from unittest.mock import patch

import pytest
import shapefile

from geocoding.schema import CREATE_TABLE_SQL
from geocoding.update_state_names import (
    StateInfo,
    _download_and_extract_states_shp,
    _read_state_lookup,
    update_state_names,
)


def _write_states_shapefile(base_path, states):
    """states: list of (statefp, name, stusps) tuples."""
    writer = shapefile.Writer(str(base_path), shapeType=shapefile.POLYGON)
    writer.field("STATEFP", "C")
    writer.field("NAME", "C")
    writer.field("STUSPS", "C")
    for statefp, name, stusps in states:
        writer.poly([[(-70.0, 43.0), (-70.0, 44.0), (-69.0, 44.0), (-70.0, 43.0)]])
        writer.record(statefp, name, stusps)
    writer.close()


def _make_streets_db(db_path, rows, with_state_columns=False):
    """rows: list of (id, tlid, statefp) tuples. Mimics a pre-state-column DB
    when with_state_columns is False, to exercise the migration path."""
    conn = sqlite3.connect(db_path)
    if with_state_columns:
        conn.executescript(CREATE_TABLE_SQL)
    else:
        conn.execute(
            """
            CREATE TABLE streets (
                id INTEGER PRIMARY KEY,
                tlid TEXT,
                fullname TEXT,
                statefp TEXT,
                countyfp TEXT,
                geometry TEXT
            )
            """
        )
    for row_id, tlid, statefp in rows:
        conn.execute(
            "INSERT INTO streets (id, tlid, statefp) VALUES (?, ?, ?)", (row_id, tlid, statefp)
        )
    conn.commit()
    conn.close()


def test_read_state_lookup(tmp_path):
    shp_base = tmp_path / "states"
    _write_states_shapefile(
        shp_base, [("23", "Maine", "ME"), ("33", "New Hampshire", "NH")]
    )

    lookup = _read_state_lookup(shp_base.with_suffix(".shp"))
    assert lookup == {
        "23": StateInfo(name="Maine", abbr="ME"),
        "33": StateInfo(name="New Hampshire", abbr="NH"),
    }


def test_read_state_lookup_raises_on_missing_fields(tmp_path):
    shp_base = tmp_path / "bad_states"
    writer = shapefile.Writer(str(shp_base), shapeType=shapefile.POLYGON)
    writer.field("STATEFP", "C")
    writer.poly([[(-70.0, 43.0), (-70.0, 44.0), (-69.0, 44.0), (-70.0, 43.0)]])
    writer.record("23")
    writer.close()

    with pytest.raises(ValueError, match="STATEFP"):
        _read_state_lookup(shp_base.with_suffix(".shp"))


def test_download_and_extract_states_shp_skips_download_if_cached(tmp_path):
    shp_path = tmp_path / "tl_2024_us_state.shp"
    shp_path.write_text("already here")

    with patch("geocoding.update_state_names.urllib.request.urlretrieve") as mock_urlretrieve:
        result = _download_and_extract_states_shp(2024, tmp_path)

    mock_urlretrieve.assert_not_called()
    assert result == shp_path


def test_download_and_extract_states_shp_downloads_when_nothing_cached(tmp_path):
    shp_base = tmp_path / "source"
    _write_states_shapefile(shp_base, [("23", "Maine", "ME")])

    def fake_urlretrieve(url, dest):
        with zipfile.ZipFile(dest, "w") as zf:
            for ext in (".shp", ".shx", ".dbf"):
                zf.write(shp_base.with_suffix(ext), f"tl_2024_us_state{ext}")

    with patch(
        "geocoding.update_state_names.urllib.request.urlretrieve", side_effect=fake_urlretrieve
    ) as mock_urlretrieve:
        result = _download_and_extract_states_shp(2024, tmp_path)

    mock_urlretrieve.assert_called_once()
    assert result == tmp_path / "tl_2024_us_state.shp"


def test_update_state_names_joins_by_statefp_and_migrates_old_schema(tmp_path):
    db_path = tmp_path / "streets.db"
    _make_streets_db(
        db_path,
        rows=[(1, "t1", "23"), (2, "t2", "33"), (3, "t3", "99")],  # 99 = no matching state
        with_state_columns=False,
    )

    shp_base = tmp_path / "states"
    _write_states_shapefile(
        shp_base, [("23", "Maine", "ME"), ("33", "New Hampshire", "NH")]
    )

    with patch(
        "geocoding.update_state_names._download_and_extract_states_shp",
        return_value=shp_base.with_suffix(".shp"),
    ):
        updated = update_state_names(db_path, 2024, tmp_path / "cache")

    assert updated == 2

    conn = sqlite3.connect(db_path)
    rows = {
        tlid: (state, abbr)
        for tlid, state, abbr in conn.execute("SELECT tlid, state, state_abbr FROM streets")
    }
    conn.close()

    assert rows == {
        "t1": ("Maine", "ME"),
        "t2": ("New Hampshire", "NH"),
        "t3": (None, None),
    }


def test_update_state_names_is_idempotent(tmp_path):
    db_path = tmp_path / "streets.db"
    _make_streets_db(db_path, rows=[(1, "t1", "23")], with_state_columns=False)

    shp_base = tmp_path / "states"
    _write_states_shapefile(shp_base, [("23", "Maine", "ME")])

    with patch(
        "geocoding.update_state_names._download_and_extract_states_shp",
        return_value=shp_base.with_suffix(".shp"),
    ):
        first = update_state_names(db_path, 2024, tmp_path / "cache")
        second = update_state_names(db_path, 2024, tmp_path / "cache")

    assert first == 1
    assert second == 0
