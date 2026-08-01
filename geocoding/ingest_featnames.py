"""Ingest a TIGER/Line featnames table (alternate street names) into SQLite.

The `edges` layer only carries one name per segment (the Census-assigned
primary name), so a user searching for a road by a different valid name
for the same physical street fails to match. TIGER/Line's separate
`featnames` table links a TLID to every name it's known by, with a
PAFLAG column ('P' = primary, 'A' = alternate) -- e.g. a segment can be
both "Pequawket Trl" (P) and "State Rte 113" (A) at once. featnames is a
plain attribute table (.dbf only, no geometry).

street_names also carries its own copies of zipl/zipr/state/state_abbr,
denormalized from the matching streets row, rather than relying on a
runtime JOIN back to streets to filter by them -- see
sync_street_names_zip_state()'s docstring for why.
"""

import sqlite3
from pathlib import Path

import shapefile

from .schema import (
    CREATE_STREET_NAMES_INDEXES_SQL,
    CREATE_STREET_NAMES_TABLE_SQL,
    ensure_street_names_columns,
)

FIELD_MAP = {
    "TLID": "tlid",
    "FULLNAME": "fullname",
    "PAFLAG": "paflag",
}


def sync_street_names_zip_state(conn: sqlite3.Connection) -> int:
    """Backfills street_names.zipl/zipr/state/state_abbr from the matching
    streets row, for any street_names rows that don't have it yet.

    Denormalized on purpose: geocode.js needs to filter candidates by
    name *and* zip *and* state together, and doing that via a runtime
    JOIN from street_names back to streets -- once per zip-matched
    streets row -- measured ~15x slower at batch scale than querying a
    single table directly (the nested per-row lookup cost dominates for
    ZIP codes with many segments). Copying these columns lets
    street_names carry its own composite index
    (UPPER(fullname), zip*, state, state_abbr), mirroring the one on
    streets, so filtering never needs the join at query time -- streets
    is only joined in afterwards, for the few rows that actually matched.

    Returns the number of rows updated. A no-op (returns 0) if streets
    doesn't exist yet -- ingest_featnames() can run standalone, e.g. in
    tests, without edges having been ingested first.
    """
    has_streets = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='streets'"
    ).fetchone()
    if not has_streets:
        return 0

    cursor = conn.execute(
        """
        UPDATE street_names
        SET zipl = (SELECT zipl FROM streets WHERE streets.tlid = street_names.tlid),
            zipr = (SELECT zipr FROM streets WHERE streets.tlid = street_names.tlid),
            state = (SELECT state FROM streets WHERE streets.tlid = street_names.tlid),
            state_abbr = (SELECT state_abbr FROM streets WHERE streets.tlid = street_names.tlid)
        WHERE zipl IS NULL
          AND tlid IN (SELECT tlid FROM streets)
        """
    )
    conn.commit()
    return cursor.rowcount


def ingest_featnames(dbf_path: Path, db_path: Path) -> int:
    """Ingest one county's featnames table into street_names.

    Only keeps rows for road features (MTFCC starting with "S"), matching
    the same filter ingest.py applies to streets. Keyed by (tlid,
    fullname), so re-ingesting is idempotent (INSERT OR IGNORE). Assumes
    the matching streets rows are already ingested (update_state.py
    ingests edges before featnames for each county) so zip/state can be
    denormalized immediately. Returns the number of rows newly inserted.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(CREATE_STREET_NAMES_TABLE_SQL)
        ensure_street_names_columns(conn)
        conn.executescript(CREATE_STREET_NAMES_INDEXES_SQL)

        with open(dbf_path, "rb") as f:
            reader = shapefile.Reader(dbf=f)
            field_names = [f[0] for f in reader.fields[1:]]
            available = [name for name in FIELD_MAP if name in field_names]
            missing = [name for name in FIELD_MAP if name not in field_names]
            if missing:
                print(f"warning: fields not in featnames table, will be left NULL: {missing}")

            columns = [FIELD_MAP[name] for name in available]
            placeholders = ", ".join("?" for _ in columns)
            insert_sql = (
                f"INSERT OR IGNORE INTO street_names ({', '.join(columns)}) "
                f"VALUES ({placeholders})"
            )

            rows = []
            for record in reader.iterRecords():
                data = record.as_dict()
                if not data.get("FULLNAME"):
                    continue
                if "MTFCC" in field_names and not (data.get("MTFCC") or "").startswith("S"):
                    continue
                rows.append([data.get(name) for name in available])

        cursor = conn.executemany(insert_sql, rows)
        conn.commit()
        inserted = cursor.rowcount

        sync_street_names_zip_state(conn)
        return inserted
    finally:
        conn.close()
