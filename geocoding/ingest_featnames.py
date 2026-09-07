"""Ingest a TIGER/Line featnames table (alternate street names) into Postgres.

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

from pathlib import Path
from typing import Optional

import psycopg
import shapefile

from .db import insert_ignore_count
from .schema import CREATE_STREET_NAMES_INDEXES_SQL, CREATE_STREET_NAMES_TABLE_SQL

FIELD_MAP = {
    "TLID": "tlid",
    "FULLNAME": "fullname",
    "PAFLAG": "paflag",
}


def sync_street_names_zip_state(conn: psycopg.Connection, tlids: Optional[list] = None) -> int:
    """Backfills street_names.zipl/zipr/state/state_abbr from the matching
    streets row, for any street_names rows that don't have it yet.

    Checks zipl and state_abbr independently (not just zipl) because
    streets.state_abbr/state went unpopulated for a long time after zipl
    already was (see ingest.py) -- a row synced before that fix has zipl
    set but state_abbr still NULL, and would otherwise never get resynced
    since it no longer matches a "hasn't been synced yet" check that only
    looks at zipl.

    `tlids`, when given, restricts the scan to just those TLIDs -- without
    it, a table-wide "state_abbr IS NULL" scan costs the same on every
    single call, so calling this once per county (as ingest_featnames()
    does) turns an O(table size) backfill into O(counties * table size).
    Measured directly: re-running update_state.py to backfill an already-
    ingested state after this state_abbr/state fix landed took >15 minutes
    per county instead of the usual few seconds, and running more than one
    state's backfill concurrently deadlocked on the resulting table-wide
    locks. ingest_featnames() always passes the current file's own TLIDs;
    the unrestricted form remains for a genuine one-off full-table pass
    (e.g. run by hand after this fix first landed, before any per-county
    call had a scoped list to work with).

    Returns the number of rows updated. A no-op (returns 0) if streets
    doesn't exist yet -- ingest_featnames() can run standalone, e.g. in
    tests, without edges having been ingested first.
    """
    has_streets = conn.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'streets'"
    ).fetchone()
    if not has_streets:
        return 0

    tlid_clause = "street_names.tlid = ANY(%(tlids)s) AND" if tlids is not None else ""
    cursor = conn.execute(
        f"""
        UPDATE street_names
        SET zipl = streets.zipl,
            zipr = streets.zipr,
            state = streets.state,
            state_abbr = streets.state_abbr
        FROM streets
        WHERE streets.tlid = street_names.tlid
          AND {tlid_clause}
          (street_names.zipl IS NULL OR street_names.state_abbr IS NULL)
        """,
        {"tlids": tlids} if tlids is not None else {},
    )
    conn.commit()
    return cursor.rowcount


def ingest_featnames(dbf_path: Path, dsn: str) -> int:
    """Ingest one county's featnames table into street_names.

    Only keeps rows for road features (MTFCC starting with "S"), matching
    the same filter ingest.py applies to streets. Keyed by (tlid,
    fullname), so re-ingesting is idempotent (ON CONFLICT DO NOTHING).
    Assumes the matching streets rows are already ingested (update_state.py
    ingests edges before featnames for each county) so zip/state can be
    denormalized immediately. Returns the number of rows newly inserted.
    """
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_STREET_NAMES_TABLE_SQL)
        conn.execute(CREATE_STREET_NAMES_INDEXES_SQL)

        with open(dbf_path, "rb") as f:
            reader = shapefile.Reader(dbf=f)
            field_names = [f[0] for f in reader.fields[1:]]
            available = [name for name in FIELD_MAP if name in field_names]
            missing = [name for name in FIELD_MAP if name not in field_names]
            if missing:
                print(f"warning: fields not in featnames table, will be left NULL: {missing}")

            columns = [FIELD_MAP[name] for name in available]
            placeholders = ", ".join("%s" for _ in columns)
            insert_sql = (
                f"INSERT INTO street_names ({', '.join(columns)}) "
                f"VALUES ({placeholders}) "
                "ON CONFLICT (tlid, fullname) DO NOTHING RETURNING id"
            )

            rows = []
            tlids = []
            for record in reader.iterRecords():
                data = record.as_dict()
                if not data.get("FULLNAME"):
                    continue
                if "MTFCC" in field_names and not (data.get("MTFCC") or "").startswith("S"):
                    continue
                rows.append([data.get(name) for name in available])
                # str(): real TIGER/Line shapefiles type TLID as numeric,
                # not character (unlike this module's own test shapefiles),
                # so pyshp hands back an int here -- ANY(%(tlids)s) below
                # needs a homogeneous text[] to compare against the text
                # tlid column (Postgres won't implicitly cast a bound
                # integer[] parameter the way a plain positional
                # int-into-text INSERT gets coerced).
                tlids.append(str(data.get("TLID")))

        inserted = insert_ignore_count(conn, insert_sql, rows)
        conn.commit()

        sync_street_names_zip_state(conn, tlids)
        return inserted
