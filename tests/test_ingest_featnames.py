import psycopg
import shapefile

from geocoding.ingest_featnames import ingest_featnames
from geocoding.schema import CREATE_STREET_NAMES_INDEXES_SQL, CREATE_STREET_NAMES_TABLE_SQL


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


def test_ingest_featnames_creates_rows(tmp_path, dsn):
    dbf_path = tmp_path / "featnames.dbf"
    _write_featnames(
        dbf_path,
        [
            ("78056932", "Pequawket Trl", "P", "S1400"),
            ("78056932", "State Rte 113", "A", "S1400"),
        ],
    )

    count = ingest_featnames(dbf_path, dsn)
    assert count == 2

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT tlid, fullname, paflag FROM street_names ORDER BY paflag"
        ).fetchall()

    assert rows == [
        ("78056932", "State Rte 113", "A"),
        ("78056932", "Pequawket Trl", "P"),
    ]


def test_ingest_featnames_skips_non_road_features(tmp_path, dsn):
    dbf_path = tmp_path / "featnames.dbf"
    _write_featnames(
        dbf_path,
        [
            ("101", "Main St", "P", "S1400"),
            ("200", "Some Creek", "P", "H3010"),  # hydrography, not a road
        ],
    )

    count = ingest_featnames(dbf_path, dsn)
    assert count == 1

    with psycopg.connect(dsn) as conn:
        tlids = {row[0] for row in conn.execute("SELECT tlid FROM street_names")}
    assert tlids == {"101"}


def test_ingest_featnames_skips_blank_names(tmp_path, dsn):
    dbf_path = tmp_path / "featnames.dbf"
    _write_featnames(dbf_path, [("101", "", "P", "S1400"), ("102", "Elm St", "P", "S1400")])

    count = ingest_featnames(dbf_path, dsn)
    assert count == 1

    with psycopg.connect(dsn) as conn:
        tlids = {row[0] for row in conn.execute("SELECT tlid FROM street_names")}
    assert tlids == {"102"}


def test_ingest_featnames_is_idempotent(tmp_path, dsn):
    dbf_path = tmp_path / "featnames.dbf"
    _write_featnames(dbf_path, [("101", "Main St", "P", "S1400")])

    first = ingest_featnames(dbf_path, dsn)
    second = ingest_featnames(dbf_path, dsn)

    assert first == 1
    assert second == 0

    with psycopg.connect(dsn) as conn:
        total = conn.execute("SELECT COUNT(*) FROM street_names").fetchone()[0]
    assert total == 1


def test_ingest_featnames_backfills_zip_state_from_streets(tmp_path, dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute(
            """
            CREATE TABLE streets (
                id BIGSERIAL PRIMARY KEY,
                tlid TEXT,
                zipl TEXT,
                zipr TEXT,
                state TEXT,
                state_abbr TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO streets (tlid, zipl, zipr, state, state_abbr) "
            "VALUES ('101', '04101', '04101', 'Maine', 'ME')"
        )
        conn.commit()

    dbf_path = tmp_path / "featnames.dbf"
    _write_featnames(dbf_path, [("101", "Main St", "P", "S1400")])
    ingest_featnames(dbf_path, dsn)

    with psycopg.connect(dsn) as conn:
        row = conn.execute(
            "SELECT zipl, zipr, state, state_abbr FROM street_names WHERE tlid = '101'"
        ).fetchone()

    assert row == ("04101", "04101", "Maine", "ME")


def test_ingest_featnames_backfills_state_even_when_zip_already_synced(tmp_path, dsn):
    # Simulates a street_names row synced before streets.state_abbr/state
    # existed: zipl/zipr already copied over, but state/state_abbr still
    # NULL -- the sync guard must not treat this row as "already synced"
    # just because zipl is set. Uses the real schema (not hand-rolled DDL)
    # so the pre-existing street_names row hits the same (tlid, fullname)
    # unique index ingest_featnames()'s own INSERT relies on for its
    # ON CONFLICT DO NOTHING.
    with psycopg.connect(dsn) as conn:
        conn.execute(
            """
            CREATE TABLE streets (
                id BIGSERIAL PRIMARY KEY,
                tlid TEXT,
                zipl TEXT,
                zipr TEXT,
                state TEXT,
                state_abbr TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO streets (tlid, zipl, zipr, state, state_abbr) "
            "VALUES ('101', '04101', '04101', 'Maine', 'ME')"
        )
        conn.execute(CREATE_STREET_NAMES_TABLE_SQL)
        conn.execute(CREATE_STREET_NAMES_INDEXES_SQL)
        conn.execute(
            "INSERT INTO street_names (tlid, fullname, zipl, zipr) "
            "VALUES ('101', 'Main St', '04101', '04101')"
        )
        conn.commit()

    dbf_path = tmp_path / "featnames.dbf"
    _write_featnames(dbf_path, [("101", "Main St", "P", "S1400")])
    ingest_featnames(dbf_path, dsn)

    with psycopg.connect(dsn) as conn:
        row = conn.execute(
            "SELECT zipl, zipr, state, state_abbr FROM street_names WHERE tlid = '101'"
        ).fetchone()

    assert row == ("04101", "04101", "Maine", "ME")
