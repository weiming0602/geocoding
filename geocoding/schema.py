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
CREATE INDEX IF NOT EXISTS idx_streets_fullname_zipl_zipr_state
    ON streets (fullname, zipl, zipr, state);
"""


def ensure_state_column(conn) -> None:
    """Adds the `state` column to an existing streets table if it predates it.

    CREATE_TABLE_SQL only affects brand-new databases (CREATE TABLE IF NOT
    EXISTS is a no-op otherwise), so already-populated databases need this
    migration to pick up columns added after they were first created.
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(streets)")}
    if "state" not in columns:
        conn.execute("ALTER TABLE streets ADD COLUMN state TEXT")
