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
CREATE INDEX IF NOT EXISTS idx_streets_fullname_upper_zip
    ON streets (UPPER(fullname), zipl, zipr, state, state_abbr);
"""

# Columns that predate the initial CREATE TABLE for databases created
# before they were added. CREATE_TABLE_SQL alone won't add them to an
# existing table (CREATE TABLE IF NOT EXISTS is a no-op), so callers must
# run ensure_columns() as a migration step for already-populated databases.
_MIGRATED_COLUMNS = {
    "state": "TEXT",
    "state_abbr": "TEXT",
}


def ensure_columns(conn) -> None:
    """Adds any columns from _MIGRATED_COLUMNS missing from an existing streets table."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(streets)")}
    for column, column_type in _MIGRATED_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE streets ADD COLUMN {column} {column_type}")
