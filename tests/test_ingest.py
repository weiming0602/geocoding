import psycopg
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


def test_ingest_creates_rows(tmp_path, dsn):
    shp_path = tmp_path / "edges"

    _write_sample_edges_shapefile(shp_path)
    count = ingest(shp_path.with_suffix(".shp"), dsn)

    assert count == 2

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT tlid, fullname, lfromadd, ltoadd, geometry FROM streets ORDER BY tlid"
        ).fetchall()

    assert rows[0][:4] == ("101", "Main St", "100", "198")
    assert rows[0][4].startswith("LINESTRING")

    assert rows[1][1] == "2nd St"
    assert rows[1][4].startswith("LINESTRING")


def test_ingest_populates_postgis_geom(tmp_path, dsn):
    shp_path = tmp_path / "edges"
    _write_sample_edges_shapefile(shp_path)

    ingest(shp_path.with_suffix(".shp"), dsn)

    with psycopg.connect(dsn) as conn:
        total, with_geom = conn.execute(
            "SELECT COUNT(*), COUNT(geom) FROM streets"
        ).fetchone()

    assert total == 2
    assert with_geom == 2


def test_ingest_skips_non_road_features(tmp_path, dsn):
    shp_path = tmp_path / "edges"

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

    count = ingest(shp_path.with_suffix(".shp"), dsn)
    assert count == 1

    with psycopg.connect(dsn) as conn:
        tlids = {row[0] for row in conn.execute("SELECT tlid FROM streets")}
    assert tlids == {"101"}


def test_ingest_is_idempotent_on_repeat_runs(tmp_path, dsn):
    shp_path = tmp_path / "edges"
    _write_sample_edges_shapefile(shp_path)

    first_count = ingest(shp_path.with_suffix(".shp"), dsn)
    second_count = ingest(shp_path.with_suffix(".shp"), dsn)

    assert first_count == 2
    assert second_count == 0

    with psycopg.connect(dsn) as conn:
        total = conn.execute("SELECT COUNT(*) FROM streets").fetchone()[0]
    assert total == 2


def _write_edges_shapefile_with_topology(path, tlid, tnidf, tnidt):
    """Like _write_sample_edges_shapefile's single-row shape, but with
    TNIDF/TNIDT fields present -- used to prove the upsert-backfill path
    (ingest.py's ON CONFLICT ... DO UPDATE) actually updates these two
    columns on an existing row, unlike every other field above which
    stays skip-on-conflict."""
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
    writer.field("TNIDF", "C")
    writer.field("TNIDT", "C")

    writer.line([[(-122.42, 37.77), (-122.41, 37.78)]])
    writer.record(
        tlid, "Main St", "100", "198", "101", "199",
        "94110", "94110", "S1400", "06", "075", tnidf, tnidt,
    )
    writer.close()


def test_ingest_backfills_tnidf_tnidt_on_an_already_ingested_row(tmp_path, dsn):
    first_shp = tmp_path / "edges1"
    _write_edges_shapefile_with_topology(first_shp, "101", "1001", "1002")
    first_count = ingest(first_shp.with_suffix(".shp"), dsn)
    assert first_count == 1

    # Re-ingesting the same TLID with different TNIDF/TNIDT -- unlike a
    # plain repeat run (test_ingest_is_idempotent_on_repeat_runs), this
    # should update the existing row's topology columns rather than
    # silently skip it.
    second_shp = tmp_path / "edges2"
    _write_edges_shapefile_with_topology(second_shp, "101", "2001", "2002")
    second_count = ingest(second_shp.with_suffix(".shp"), dsn)
    assert second_count == 1

    with psycopg.connect(dsn) as conn:
        total = conn.execute("SELECT COUNT(*) FROM streets").fetchone()[0]
        row = conn.execute(
            "SELECT fullname, tnidf, tnidt FROM streets WHERE tlid = '101'"
        ).fetchone()

    assert total == 1  # backfilled the existing row, not a duplicate
    assert row == ("Main St", "2001", "2002")

    # A third run with unchanged tnidf/tnidt shouldn't report a "change"
    # (the WHERE ... IS DISTINCT FROM guard should skip a no-op update).
    third_count = ingest(second_shp.with_suffix(".shp"), dsn)
    assert third_count == 0


def test_ingest_skips_only_overlapping_rows(tmp_path, dsn):
    first_shp = tmp_path / "edges1"
    _write_sample_edges_shapefile(first_shp)
    ingest(first_shp.with_suffix(".shp"), dsn)

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

    count = ingest(tmp_path / "edges2.shp", dsn)
    assert count == 1  # only TLID 103 is new

    with psycopg.connect(dsn) as conn:
        tlids = {row[0] for row in conn.execute("SELECT tlid FROM streets")}
    assert tlids == {"101", "102", "103"}
