"""One-time migration: copy data from the legacy SQLite databases into the
new PostgreSQL/PostGIS databases (see schema.py for the target DDL).

Two independent migrations, matching the existing two-database split:
- geocoding.sqlite (streets, street_names) -> the `geocoding` Postgres db
- users.sqlite (users)                     -> the `geocoding_users` Postgres db

`geom` is NOT copied from the source SQLite file -- that column holds a
SpatiaLite-format geometry blob, a different on-disk format than PostGIS
uses. Instead, after loading `geometry` (the plain WKT text column both
apps actually read), a single UPDATE recomputes `geom` from that WKT via
ST_GeomFromText, once, for every row. That's the whole backfill; nothing
like add_geometry_column.py's trigger workarounds is needed here.

Usage:
    .venv/bin/python -m geocoding.migrate_to_postgres \\
        --geocoding-sqlite /path/to/geocoding.sqlite \\
        --users-sqlite /path/to/users.sqlite

Safe to re-run: truncates each target table before reloading, unless
--no-truncate is passed.
"""

import argparse
import sqlite3

import psycopg

from .schema import (
    CREATE_INDEXES_SQL,
    CREATE_STREET_NAMES_INDEXES_SQL,
    CREATE_STREET_NAMES_TABLE_SQL,
    CREATE_TABLE_SQL,
)

STREETS_COLUMNS = [
    "tlid",
    "fullname",
    "lfromadd",
    "ltoadd",
    "rfromadd",
    "rtoadd",
    "zipl",
    "zipr",
    "mtfcc",
    "statefp",
    "countyfp",
    "state",
    "state_abbr",
    "geometry",
    "minx",
    "miny",
    "maxx",
    "maxy",
]

STREET_NAMES_COLUMNS = ["tlid", "fullname", "paflag", "zipl", "zipr", "state", "state_abbr"]

USERS_COLUMNS = ["email", "tier", "period_start", "used_this_period"]

CREATE_USERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    tier INTEGER NOT NULL,
    period_start TEXT NOT NULL,
    used_this_period INTEGER NOT NULL DEFAULT 0
);
"""


def _copy_table(pg_conn, sqlite_conn, table, columns, truncate):
    if truncate:
        pg_conn.execute(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE")

    select_sql = f"SELECT {', '.join(columns)} FROM {table}"
    rows = sqlite_conn.execute(select_sql)

    copy_sql = f"COPY {table} ({', '.join(columns)}) FROM STDIN"
    count = 0
    with pg_conn.cursor().copy(copy_sql) as copy:
        for row in rows:
            copy.write_row(row)
            count += 1
    return count


def migrate_geocoding_db(sqlite_path, pg_dsn, truncate=True):
    sqlite_conn = sqlite3.connect(sqlite_path)
    with psycopg.connect(pg_dsn) as pg_conn:
        pg_conn.execute(CREATE_TABLE_SQL)
        pg_conn.execute(CREATE_STREET_NAMES_TABLE_SQL)

        streets_count = _copy_table(pg_conn, sqlite_conn, "streets", STREETS_COLUMNS, truncate)
        names_count = _copy_table(
            pg_conn, sqlite_conn, "street_names", STREET_NAMES_COLUMNS, truncate
        )

        pg_conn.execute(CREATE_INDEXES_SQL)
        pg_conn.execute(CREATE_STREET_NAMES_INDEXES_SQL)

        pg_conn.execute(
            "UPDATE streets SET geom = ST_GeomFromText(geometry, 4326) "
            "WHERE geometry IS NOT NULL AND geom IS NULL"
        )
        pg_conn.commit()

    sqlite_conn.close()
    print(f"streets: {streets_count} rows, street_names: {names_count} rows")


def migrate_users_db(sqlite_path, pg_dsn, truncate=True):
    sqlite_conn = sqlite3.connect(sqlite_path)
    with psycopg.connect(pg_dsn) as pg_conn:
        pg_conn.execute(CREATE_USERS_TABLE_SQL)
        count = _copy_table(pg_conn, sqlite_conn, "users", USERS_COLUMNS, truncate)
        pg_conn.commit()

    sqlite_conn.close()
    print(f"users: {count} rows")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geocoding-sqlite", help="Path to geocoding.sqlite")
    parser.add_argument("--users-sqlite", help="Path to users.sqlite")
    parser.add_argument(
        "--geocoding-pg-dsn", default="dbname=geocoding user=my_ai", help="Target Postgres DSN"
    )
    parser.add_argument(
        "--users-pg-dsn",
        default="dbname=geocoding_users user=my_ai",
        help="Target Postgres DSN",
    )
    parser.add_argument(
        "--no-truncate",
        action="store_true",
        help="Don't truncate target tables before loading (append instead)",
    )
    args = parser.parse_args()

    if not args.geocoding_sqlite and not args.users_sqlite:
        parser.error("pass --geocoding-sqlite and/or --users-sqlite")

    truncate = not args.no_truncate

    if args.geocoding_sqlite:
        migrate_geocoding_db(args.geocoding_sqlite, args.geocoding_pg_dsn, truncate)
    if args.users_sqlite:
        migrate_users_db(args.users_sqlite, args.users_pg_dsn, truncate)


if __name__ == "__main__":
    main()
