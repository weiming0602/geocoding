import sqlite3

import shapefile

from geocoding.ingest import ingest


def _write_sample_edges_shapefile(path):
    writer = shapefile.Writer(str(path), shapeType=shapefile.POLYLINE)
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

    writer.line([[(-122.42, 37.77), (-122.41, 37.78)]])
    writer.record(
        "101", "Main St", "100", "198", "101", "199",
        "94110", "94110", "S1400", "06", "075",
    )

    writer.line([[(-122.40, 37.76), (-122.39, 37.75), (-122.38, 37.75)]])
    writer.record(
        "102", "2nd St", "200", "298", "201", "299",
        "94103", "94103", "S1400", "06", "075",
    )

    writer.close()


def test_ingest_creates_rows(tmp_path):
    shp_path = tmp_path / "edges"
    db_path = tmp_path / "streets.db"

    _write_sample_edges_shapefile(shp_path)
    count = ingest(shp_path.with_suffix(".shp"), db_path)

    assert count == 2

    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT tlid, fullname, lfromadd, ltoadd, geometry FROM streets ORDER BY tlid"
    ).fetchall()
    conn.close()

    assert rows[0][:4] == ("101", "Main St", "100", "198")
    assert rows[0][4].startswith("LINESTRING")

    assert rows[1][1] == "2nd St"
    assert rows[1][4].startswith("LINESTRING")


def test_ingest_skips_non_road_features(tmp_path):
    shp_path = tmp_path / "edges"
    db_path = tmp_path / "streets.db"

    writer = shapefile.Writer(str(shp_path), shapeType=shapefile.POLYLINE)
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

    writer.line([[(-122.42, 37.77), (-122.41, 37.78)]])
    writer.record("101", "Main St", "100", "198", "101", "199", "94110", "94110", "S1400", "06", "075")

    writer.line([[(-122.40, 37.76), (-122.39, 37.75)]])
    writer.record("200", "", "", "", "", "", "", "", "R1011", "06", "075")  # railroad

    writer.line([[(-122.30, 37.60), (-122.29, 37.61)]])
    writer.record("300", "Sample Creek", "", "", "", "", "", "", "H3010", "06", "075")  # hydrography

    writer.close()

    count = ingest(shp_path.with_suffix(".shp"), db_path)
    assert count == 1

    conn = sqlite3.connect(db_path)
    tlids = {row[0] for row in conn.execute("SELECT tlid FROM streets")}
    conn.close()
    assert tlids == {"101"}


def test_ingest_is_idempotent_on_repeat_runs(tmp_path):
    shp_path = tmp_path / "edges"
    db_path = tmp_path / "streets.db"
    _write_sample_edges_shapefile(shp_path)

    first_count = ingest(shp_path.with_suffix(".shp"), db_path)
    second_count = ingest(shp_path.with_suffix(".shp"), db_path)

    assert first_count == 2
    assert second_count == 0

    conn = sqlite3.connect(db_path)
    total = conn.execute("SELECT COUNT(*) FROM streets").fetchone()[0]
    conn.close()
    assert total == 2


def test_ingest_skips_only_overlapping_rows(tmp_path):
    db_path = tmp_path / "streets.db"

    first_shp = tmp_path / "edges1"
    _write_sample_edges_shapefile(first_shp)
    ingest(first_shp.with_suffix(".shp"), db_path)

    # A second "county" file that repeats one TLID (101) and adds a new one (103).
    writer = shapefile.Writer(str(tmp_path / "edges2"), shapeType=shapefile.POLYLINE)
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
    writer.line([[(-122.42, 37.77), (-122.41, 37.78)]])
    writer.record("101", "Main St", "100", "198", "101", "199", "94110", "94110", "S1400", "06", "075")
    writer.line([[(-122.36, 37.70), (-122.35, 37.71)]])
    writer.record("103", "3rd St", "300", "398", "301", "399", "94104", "94104", "S1400", "06", "075")
    writer.close()

    count = ingest(tmp_path / "edges2.shp", db_path)
    assert count == 1  # only TLID 103 is new

    conn = sqlite3.connect(db_path)
    tlids = {row[0] for row in conn.execute("SELECT tlid FROM streets")}
    conn.close()
    assert tlids == {"101", "102", "103"}
