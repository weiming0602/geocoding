import psycopg
import shapefile

from geocoding.ingest_featnames import ingest_featnames, sync_street_names_zip_state
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


def test_ingest_featnames_handles_numeric_tlid_field(tmp_path, dsn):
    # Real TIGER/Line featnames files type TLID as numeric ("N"), not
    # character ("C") like this module's other tests use for convenience
    # -- pyshp hands back a Python int for a numeric field, unlike the str
    # every other test here gets from a "C" field. Confirmed directly: a
    # real Texas ingest crashed with "operator does not exist: text =
    # integer" from sync_street_names_zip_state's ANY(%(tlids)s) once real
    # TLIDs (ints) reached it, something a "C"-field test TLID could never
    # catch.
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
    writer = shapefile.Writer(str(dbf_path.with_suffix("")), shapeType=shapefile.NULL)
    writer.field("TLID", "N", 20, 0)
    writer.field("FULLNAME", "C")
    writer.field("PAFLAG", "C")
    writer.field("MTFCC", "C")
    writer.null()
    writer.record(101, "Main St", "P", "S1400")
    writer.close()

    count = ingest_featnames(dbf_path, dsn)
    assert count == 1

    with psycopg.connect(dsn) as conn:
        row = conn.execute(
            "SELECT tlid, zipl, state_abbr FROM street_names WHERE tlid = '101'"
        ).fetchone()

    assert row == ("101", "04101", "ME")


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


def test_sync_street_names_zip_state_with_tlids_only_touches_those_rows(dsn):
    # This is the actual fix for a real production incident: a table-wide
    # scan on every call (once per county -- ingest_featnames() calls this
    # automatically) turned a one-time backfill into O(counties * table
    # size), which measured >15 minutes per county when re-running
    # update_state.py to backfill an already-ingested state, and deadlocked
    # entirely when two states' backfills ran concurrently against the
    # same table. Passing `tlids` must restrict the UPDATE to just those
    # rows -- proven here by a row NOT in the list staying unsynced.
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
            "INSERT INTO streets (tlid, zipl, zipr, state, state_abbr) VALUES "
            "('101', '04101', '04101', 'Maine', 'ME'), "
            "('102', '04102', '04102', 'Maine', 'ME')"
        )
        conn.execute(CREATE_STREET_NAMES_TABLE_SQL)
        conn.execute(CREATE_STREET_NAMES_INDEXES_SQL)
        conn.execute(
            "INSERT INTO street_names (tlid, fullname) VALUES ('101', 'Main St'), ('102', 'Elm St')"
        )
        conn.commit()

        updated = sync_street_names_zip_state(conn, ["101"])
        assert updated == 1

        rows = {
            row[0]: row[1:]
            for row in conn.execute("SELECT tlid, zipl, state_abbr FROM street_names ORDER BY tlid")
        }

    assert rows["101"] == ("04101", "ME")
    assert rows["102"] == (None, None)  # not in the tlids list -- left untouched


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
