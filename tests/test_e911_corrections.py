from address_inference import e911_corrections


def test_apply_replaces_only_matching_e911_building():
    rows = [("a", 72, "MAQUOIT DRIVE", "m", 1.0, 2.0, "old72"),
            ("b", 76, "MAQUOIT DRIVE", "m", 1.0, 2.0, "moved"),
            ("c", 84, "MAQUOIT DRIVE", "m", 1.0, 2.0, "keep")]
    fixes = {"a": ("old72", "new72"), "b": ("old76", "new76")}
    out, applied = e911_corrections.apply(rows, fixes)
    assert applied == 1
    assert out[0][-1] == "new72"
    assert out[1][-1] == "moved"  # E911 moved the point since: the fix is skipped
    assert out[2] == rows[2]


def test_load_and_write_round_trip(dsn):
    import psycopg
    assert e911_corrections.load(psycopg.connect(dsn), "Freeport") == {}
    assert e911_corrections.write(dsn) == len(e911_corrections.CORRECTIONS)
    with psycopg.connect(dsn) as conn:
        got = e911_corrections.load(conn, "freeport")
    assert len(got) == len(e911_corrections.CORRECTIONS)
