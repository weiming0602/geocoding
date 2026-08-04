"""Small Postgres helpers shared by the ingest scripts."""


def insert_ignore_count(conn, insert_sql, rows):
    """Runs `insert_sql` (an INSERT ... ON CONFLICT DO NOTHING RETURNING <pk>)
    once per row in `rows`, returning how many were actually inserted.

    psycopg's cursor.rowcount isn't reliable after executemany() -- it
    reflects the driver's own batching, not "how many of these conflicted".
    RETURNING lets us count real inserts directly: a skipped (conflicting)
    row returns nothing, so summing result-set sizes across the batch gives
    the true insert count.
    """
    if not rows:
        return 0
    cursor = conn.cursor()
    cursor.executemany(insert_sql, rows, returning=True)
    count = 0
    while True:
        count += len(cursor.fetchall())
        if not cursor.nextset():
            break
    return count
