"""Shared pytest fixtures for the Postgres-backed test suite.

Each test gets its own throwaway Postgres database (not just a schema)
so tests can run schema.py's CREATE TABLE statements directly and never
see another test's rows -- mirroring how the old suite gave each test
its own tmp_path SQLite file.
"""

import uuid

import psycopg
import pytest

ADMIN_DSN = "dbname=postgres user=my_ai"


@pytest.fixture
def dsn():
    db_name = f"geocoding_test_{uuid.uuid4().hex[:16]}"

    with psycopg.connect(ADMIN_DSN, autocommit=True) as admin_conn:
        admin_conn.execute(f"CREATE DATABASE {db_name}")

    test_dsn = f"dbname={db_name} user=my_ai"
    with psycopg.connect(test_dsn, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    yield test_dsn

    with psycopg.connect(ADMIN_DSN, autocommit=True) as admin_conn:
        admin_conn.execute(f"DROP DATABASE IF EXISTS {db_name} WITH (FORCE)")
