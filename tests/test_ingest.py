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
