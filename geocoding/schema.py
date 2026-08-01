"""SQLite schema for ingested TIGER/Line street edges."""

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS streets (
    id INTEGER PRIMARY KEY,
    tlid TEXT,
    fullname TEXT,
    lfromadd TEXT,
    ltoadd TEXT,
    rfromadd TEXT,
    rtoadd TEXT,
    zipl TEXT,
    zipr TEXT,
    mtfcc TEXT,
    statefp TEXT,
    countyfp TEXT,
    state TEXT,
    state_abbr TEXT,
    geometry TEXT,
    minx REAL,
    miny REAL,
    maxx REAL,
    maxy REAL
);
"""

CREATE_INDEXES_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_streets_tlid_unique ON streets (tlid);
CREATE INDEX IF NOT EXISTS idx_streets_fullname ON streets (fullname);
CREATE INDEX IF NOT EXISTS idx_streets_zip ON streets (zipl, zipr);
CREATE INDEX IF NOT EXISTS idx_streets_bbox ON streets (minx, miny, maxx, maxy);
CREATE INDEX IF NOT EXISTS idx_streets_state ON streets (state);
CREATE INDEX IF NOT EXISTS idx_streets_state_abbr ON streets (state_abbr);
CREATE INDEX IF NOT EXISTS idx_streets_fullname_zipl_zipr_state
    ON streets (fullname, zipl, zipr, state);
-- geocode.js's actual queries compare UPPER(fullname), which the plain
-- index above can't serve (SQLite can't use an index on a column through
-- a function wrapping it). Without this, SQLite falls back to searching
-- by zipl alone and filtering every row in that ZIP row-by-row -- fine
-- for a single request, ~10x slower at batch scale (measured on 10k rows).
-- (Superseded for name matching by street_names below, kept for streets
-- rows that predate street_names or any other direct-fullname query.)
CREATE INDEX IF NOT EXISTS idx_streets_fullname_upper_zip
    ON streets (UPPER(fullname), zipl, zipr, state, state_abbr);
CREATE INDEX IF NOT EXISTS idx_streets_fullname_upper_zipr
    ON streets (UPPER(fullname), zipr, zipl, state, state_abbr);
-- zipl-first (idx_streets_zip) only helps zipl-anchored lookups; even
-- house numbers query zipr, which without this falls back to a full
-- table scan (measured: ~300ms/miss vs ~3ms/miss with this in place).
CREATE INDEX IF NOT EXISTS idx_streets_zipr_zipl ON streets (zipr, zipl);
"""

CREATE_STREET_NAMES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS street_names (
    id INTEGER PRIMARY KEY,
    tlid TEXT NOT NULL,
    fullname TEXT NOT NULL,
    paflag TEXT,
    zipl TEXT,
    zipr TEXT,
    state TEXT,
    state_abbr TEXT
);
"""

CREATE_STREET_NAMES_INDEXES_SQL = """
-- Same (tlid, fullname) row can appear once per county file at most, but
-- re-ingesting (idempotency) relies on this to dedupe via INSERT OR IGNORE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_street_names_tlid_fullname_unique
    ON street_names (tlid, fullname);
CREATE INDEX IF NOT EXISTS idx_street_names_tlid ON street_names (tlid);
-- zipl/zipr/state/state_abbr are denormalized copies from the matching
-- streets row (see sync_street_names_zip_state in ingest_featnames.py).
-- This is deliberate, not an oversight: geocode.js needs to filter by
-- name+zip+state together, and a runtime JOIN back to streets for that
-- filtering step measured ~15x slower at batch scale than querying one
-- table directly (nested-loop cost of a nested lookup per zip-matched
-- row, versus streets' original single-table design). These composite
-- expression indexes mirror streets' idx_streets_fullname_upper_zip(r)
-- exactly, for the same reason: geocode.js compares UPPER(fullname).
CREATE INDEX IF NOT EXISTS idx_street_names_upper_fullname_zipl
    ON street_names (UPPER(fullname), zipl, zipr, state, state_abbr);
CREATE INDEX IF NOT EXISTS idx_street_names_upper_fullname_zipr
    ON street_names (UPPER(fullname), zipr, zipl, state, state_abbr);
-- The two indexes above lead with UPPER(fullname), which is useless for
-- geocode.js's LIKE '%...%' fallback (leading wildcard can't seek an
-- index). Without a zip-led index, an unmatched/misspelled street name
-- forces a full table scan of street_names on every fallback query
-- (measured: 300-1500ms per miss on the real DB). These mirror streets'
-- idx_streets_zip / idx_streets_zipr_zipl so the fallback can filter down
-- to just that ZIP's rows first, same as it did before street_names existed.
CREATE INDEX IF NOT EXISTS idx_street_names_zipl_zipr ON street_names (zipl, zipr);
CREATE INDEX IF NOT EXISTS idx_street_names_zipr_zipl ON street_names (zipr, zipl);
"""

# Columns that predate the initial CREATE TABLE for databases created
# before they were added. CREATE_TABLE_SQL alone won't add them to an
# existing table (CREATE TABLE IF NOT EXISTS is a no-op), so callers must
# run ensure_columns() as a migration step for already-populated databases.
_MIGRATED_COLUMNS = {
    "state": "TEXT",
    "state_abbr": "TEXT",
}

_MIGRATED_STREET_NAMES_COLUMNS = {
    "zipl": "TEXT",
    "zipr": "TEXT",
    "state": "TEXT",
    "state_abbr": "TEXT",
}


def ensure_columns(conn) -> None:
    """Adds any columns from _MIGRATED_COLUMNS missing from an existing streets table."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(streets)")}
    for column, column_type in _MIGRATED_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE streets ADD COLUMN {column} {column_type}")


def ensure_street_names_columns(conn) -> None:
    """Adds any columns from _MIGRATED_STREET_NAMES_COLUMNS missing from
    an existing street_names table."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(street_names)")}
    for column, column_type in _MIGRATED_STREET_NAMES_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE street_names ADD COLUMN {column} {column_type}")
