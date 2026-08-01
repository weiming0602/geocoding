import sqlite3

import shapefile

from geocoding.ingest_featnames import ingest_featnames


def _write_featnames(path, rows):
    """rows: list of (tlid, fullname, paflag, mtfcc) tuples."""
    writer = shapefile.Writer(str(path), shapeType=shapefile.NULL)
    writer.field("TLID", "C")
    writer.field("FULLNAME", "C")
    writer.field("PAFLAG", "C")
    writer.field("MTFCC", "C")
    for tlid, fullname, paflag, mtfcc in rows:
        writer.null()
        writer.record(tlid, fullname, paflag, mtfcc)
    writer.close()


def test_ingest_featnames_creates_rows(tmp_path):
    dbf_path = tmp_path / "featnames.dbf"
    db_path = tmp_path / "streets.db"
    _write_featnames(
        dbf_path,
        [
            ("78056932", "Pequawket Trl", "P", "S1400"),
            ("78056932", "State Rte 113", "A", "S1400"),
        ],
    )

    count = ingest_featnames(dbf_path, db_path)
    assert count == 2

    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT tlid, fullname, paflag FROM street_names ORDER BY paflag"
    ).fetchall()
    conn.close()

    assert rows == [
        ("78056932", "State Rte 113", "A"),
        ("78056932", "Pequawket Trl", "P"),
    ]


def test_ingest_featnames_skips_non_road_features(tmp_path):
    dbf_path = tmp_path / "featnames.dbf"
    db_path = tmp_path / "streets.db"
    _write_featnames(
        dbf_path,
        [
            ("101", "Main St", "P", "S1400"),
            ("200", "Some Creek", "P", "H3010"),  # hydrography, not a road
        ],
    )

    count = ingest_featnames(dbf_path, db_path)
    assert count == 1

    conn = sqlite3.connect(db_path)
    tlids = {row[0] for row in conn.execute("SELECT tlid FROM street_names")}
    conn.close()
    assert tlids == {"101"}


def test_ingest_featnames_skips_blank_names(tmp_path):
    dbf_path = tmp_path / "featnames.dbf"
    db_path = tmp_path / "streets.db"
    _write_featnames(dbf_path, [("101", "", "P", "S1400"), ("102", "Elm St", "P", "S1400")])

    count = ingest_featnames(dbf_path, db_path)
    assert count == 1

    conn = sqlite3.connect(db_path)
    tlids = {row[0] for row in conn.execute("SELECT tlid FROM street_names")}
    conn.close()
    assert tlids == {"102"}


def test_ingest_featnames_is_idempotent(tmp_path):
    dbf_path = tmp_path / "featnames.dbf"
    db_path = tmp_path / "streets.db"
    _write_featnames(dbf_path, [("101", "Main St", "P", "S1400")])

    first = ingest_featnames(dbf_path, db_path)
    second = ingest_featnames(dbf_path, db_path)

    assert first == 1
    assert second == 0

    conn = sqlite3.connect(db_path)
    total = conn.execute("SELECT COUNT(*) FROM street_names").fetchone()[0]
    conn.close()
    assert total == 1
