"""Confirmed E911 label corrections (internal teacher/grader only).

E911 is the experiment's teacher and grader, never a model input. Where the
owner confirmed that an E911 point sits on the wrong building (Google
Maps, the tax roll and imagery agreeing against it), the corrected building
replaces E911's for training labels and scoring. Each fix is listed here, in
code, with its evidence; `python -m address_inference.e911_corrections
"dbname=geocoding"` (re)writes them into address_inference.e911_corrections.

A correction only applies while E911 still puts the point on the building it
had when the fix was made (`e911_building`): if a later E911 load moves the
point, the fix is skipped instead of overriding the new data.
"""
import sys

import psycopg

# (site_uid, town, street, number, e911_building, corrected_building, evidence)
CORRECTIONS = [
    # Maquoit Drive, Freeport, even side 72-80 (owner, 2026-11-26): E911's points sit one house behind. Google labels
    # the brown-roof house 76, the next 78 and the next 80, matching the tax roll's lots (76, 78, 80, 84); E911 had
    # 72/76/78 on them and 80 + 84 both on 84's house. 70 (lot 72's second house, a guest/rental unit) and 84 are
    # right in E911 and unchanged.
    ("urn:emergency:uid:gis:SSAP:740832:ngesi.maine.gov", "Freeport", "MAQUOIT DRIVE", 72,
     "82c19922-cbce-4ee7-8a57-a1505af36dbd", "aa6fc034-2a59-426b-bbaf-5d0a3417b627",
     "lot 72's road house (tax lot 72); E911 had 76's house"),
    ("urn:emergency:uid:gis:SSAP:699600:ngesi.maine.gov", "Freeport", "MAQUOIT DRIVE", 76,
     "4070255a-ba7b-4dec-8991-d7d7ea410b28", "82c19922-cbce-4ee7-8a57-a1505af36dbd",
     "Google 76 = brown roof = tax lot 76; E911 had 78's house"),
    ("urn:emergency:uid:gis:SSAP:699607:ngesi.maine.gov", "Freeport", "MAQUOIT DRIVE", 78,
     "3edd902c-afd5-4cb0-85bf-74aa5a489c25", "4070255a-ba7b-4dec-8991-d7d7ea410b28",
     "Google 78 = tax lot 78; E911 had 80's house"),
    ("urn:emergency:uid:gis:SSAP:699598:ngesi.maine.gov", "Freeport", "MAQUOIT DRIVE", 80,
     "f0e80ed3-e9f5-4d6e-b094-eecc9adb2e6d", "3edd902c-afd5-4cb0-85bf-74aa5a489c25",
     "Google 80 = tax lot 80; E911 had it on 84's house with 84"),
]

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.e911_corrections (
    site_uid TEXT PRIMARY KEY,
    town TEXT NOT NULL,
    street TEXT NOT NULL,
    number INTEGER NOT NULL,
    e911_building TEXT NOT NULL,
    corrected_building TEXT NOT NULL,
    evidence TEXT NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


def write(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS address_inference")
        conn.execute(SCHEMA_SQL)
        conn.execute("DELETE FROM address_inference.e911_corrections")
        for row in CORRECTIONS:
            conn.execute("INSERT INTO address_inference.e911_corrections "
                         "(site_uid, town, street, number, e911_building, corrected_building, evidence) "
                         "VALUES (%s, %s, %s, %s, %s, %s, %s)", row)
    return len(CORRECTIONS)


def load(conn, town) -> dict:
    """{site_uid: (e911_building, corrected_building)} for `town`; {} if the table doesn't exist."""
    if conn.execute("SELECT to_regclass('address_inference.e911_corrections') IS NULL").fetchone()[0]:
        return {}
    rows = conn.execute("SELECT site_uid, e911_building, corrected_building FROM address_inference.e911_corrections "
                        "WHERE upper(town) = upper(%s)", (town,)).fetchall()
    return {uid: (old, new) for uid, old, new in rows}


def apply(addresses, corrections):
    """ADDRESSES_SQL rows (site_uid, number, street, method, lat, lon, true_id) with confirmed fixes applied:
    returns (rows, number applied). A fix whose E911 building no longer matches is skipped."""
    out, applied = [], 0
    for row in addresses:
        fix = corrections.get(row[0])
        if fix is not None and row[-1] == fix[0]:
            row = (*row[:-1], fix[1])
            applied += 1
        out.append(row)
    return out, applied


if __name__ == "__main__":
    print(f"wrote {write(sys.argv[1])} corrections")
