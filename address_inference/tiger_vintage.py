"""Which `streets` pieces TIGER has retired since they were loaded.

The 2026-11-12 TIGER 2026 load was insert-only, so `streets` still holds the 2024 pieces TIGER 2026 redrew:
31,428 Maine pieces, 18,762 of them lying on a current piece of the same name. Deleting them cost Harpswell 90
numbers (2026-11-18): TIGER 2026 is often coarser -- High Head Road's 2026 piece 655906711 is one 657 m line,
right side 245-61, where the 2024 pieces split it into 165-61, 181-167, 197-183, 245-199. So nothing is deleted;
this only records which tlids are retired, in address_inference.tiger_retired, for street_match.FINE_OLD_PIECES.

Usage: python -m address_inference.tiger_vintage "dbname=geocoding" me --edges-dir /path/to/data/me [--year 2026]
"""
import argparse
import glob

import psycopg
import shapefile

from address_inference.regions import load_region

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.tiger_retired (
    state_abbr text NOT NULL, tlid text NOT NULL, current_year integer NOT NULL,
    PRIMARY KEY (state_abbr, tlid))
"""


def current_tlids(edges_dir: str, state_fips: str, year: int) -> set:
    tlids = set()
    for path in sorted(glob.glob(f"{edges_dir}/tl_{year}_{state_fips}*_edges.dbf")):
        with open(path, "rb") as f:
            for rec in shapefile.Reader(dbf=f).iterRecords(fields=["TLID"]):
                tlids.add(str(int(rec[0])))
    return tlids


def record_retired(dsn, region, edges_dir: str, year: int) -> int:
    current = current_tlids(edges_dir, region.state_fips, year)
    if not current:
        raise ValueError(f"no tl_{year}_{region.state_fips}*_edges.dbf in {edges_dir}")
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_SQL)
        conn.execute("CREATE TEMP TABLE current_tlids (tlid text PRIMARY KEY)")
        with conn.cursor().copy("COPY current_tlids (tlid) FROM STDIN") as cp:
            for t in current:
                cp.write_row((t,))
        conn.execute("DELETE FROM address_inference.tiger_retired WHERE state_abbr = %s", (region.state_abbr,))
        conn.execute("""
            INSERT INTO address_inference.tiger_retired
            SELECT s.state_abbr, s.tlid, %s FROM streets s
            WHERE s.state_abbr = %s AND NOT EXISTS (SELECT 1 FROM current_tlids c WHERE c.tlid = s.tlid)""",
                     (year, region.state_abbr))
        return conn.execute("SELECT count(*) FROM address_inference.tiger_retired WHERE state_abbr = %s",
                            (region.state_abbr,)).fetchone()[0]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dsn")
    p.add_argument("region")
    p.add_argument("--edges-dir", required=True)
    p.add_argument("--year", type=int, default=2026)
    a = p.parse_args()
    print(record_retired(a.dsn, load_region(a.region), a.edges_dir, a.year), "retired pieces recorded")


if __name__ == "__main__":
    main()
