"""TIGER validation before assignment (owner, 2026-11-19: "we can't afford running untrusted data resources without
validations ... whenever we run some areas where there are no E911 data available ... we need to do validations
before doing assignments, especially on tiger data").

Per street side (street, parity), using only data every region has -- TIGER, the address list being placed,
building footprints -- never E911 positions:

  placeholder   TIGER's highest number on the side >= PLACEHOLDER x the list's highest (Eider Lane 99 vs 43)
  uncovered     share of the list's numbers no TIGER range on the side covers
  uneven        max / min numbers-per-meter over the side's ranged pieces (Maquoit Drive ~20)
  crammed       a ranged piece shorter than CRAMMED_M carrying > CRAMMED_PER_M numbers per meter
  duplicate     ranged pieces lying on another ranged piece of the street (TIGER 2024 + 2026 both kept)
  continuation  an unclaimed piece named as the street without its type word touching the street (High Head)
  one_sided     share of the side's length whose piece has no range on this side (FILL_MISSING_SIDE borrows)
  houses_gap    |numbers - house lots| on the side, relative to numbers (soft: footprints miss and add)

`score` = number of hard flags. Written to address_inference.tiger_qa (one row per town, street, parity).
`--check` (E911 towns only) reports, per flag, the wrong rate of its numbers on the saved map against the town's
average -- how well each flag predicts failure, so the stage can be trusted where no E911 exists.

Usage: python -m address_inference.tiger_qa "dbname=geocoding" me --town Topsham [--check]
"""
import argparse
from collections import defaultdict

import numpy as np
import psycopg

from .regions import load_region
from .street_names import base_name, canonical

PLACEHOLDER = 2.0
UNCOVERED = 0.15
UNEVEN = 8.0
CRAMMED_M = 80
CRAMMED_PER_M = 0.6
ONE_SIDED = 0.3
HOUSES_GAP = 0.5
HOMES = ("Single Family Dwelling", "Multi - Family Dwelling", "Manufactured Home")

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.tiger_qa (
    region_id TEXT NOT NULL, town TEXT NOT NULL, street TEXT NOT NULL, parity INT NOT NULL,
    numbers INT, list_top INT, tiger_top INT, placeholder REAL, uncovered REAL, uneven REAL, crammed INT,
    duplicate INT, continuation INT, one_sided REAL, houses INT, houses_gap REAL, score INT, flags TEXT,
    PRIMARY KEY (region_id, town, street, parity))
"""
SEGMENTS_SQL = """
SELECT m.label_street, s.tlid, s.fullname, s.lfromadd, s.ltoadd, s.rfromadd, s.rtoadd, ST_Length(s.geom::geography)
FROM address_inference.street_match_segments m JOIN streets s ON s.tlid = m.tlid
WHERE m.region_id = %(region)s AND m.town = %(town)s
"""
NUMBERS_SQL = """
SELECT upper(a.street_fullname), a.address_number FROM address_points a
WHERE a.town = %(town)s AND a.state_abbr = %(state)s AND a.address_number IS NOT NULL
"""
DUPLICATE_SQL = """
SELECT DISTINCT a.tlid FROM streets a JOIN streets b
  ON b.tlid = ANY(%(tlids)s) AND b.tlid <> a.tlid AND b.geom && ST_Expand(a.geom, 0.0003)
WHERE a.tlid = ANY(%(tlids)s)
  AND (coalesce(a.lfromadd, '') <> '' OR coalesce(a.rfromadd, '') <> '')
  AND (coalesce(b.lfromadd, '') <> '' OR coalesce(b.rfromadd, '') <> '')
  AND ST_Length(ST_Intersection(a.geom, ST_Buffer(b.geom::geography, 15)::geometry)::geography)
      >= 0.8 * ST_Length(a.geom::geography)
"""
TOUCHING_SQL = """
SELECT DISTINCT s.tlid, s.fullname FROM streets s
JOIN streets t ON t.tlid = ANY(%(tlids)s) AND s.geom && ST_Expand(t.geom, 0.0001)
WHERE NOT (s.tlid = ANY(%(tlids)s)) AND NOT (s.tlid = ANY(%(claimed)s)) AND coalesce(s.fullname, '') <> ''
  AND ST_DWithin(s.geom::geography, t.geom::geography, 2)
"""
HOUSES_SQL = """
SELECT DISTINCT ON (b.source_id) b.tlid, b.side, coalesce(bp.parcel_id, b.source_id)
FROM address_inference.building_segments b
JOIN address_inference.structures s USING (source_id)
LEFT JOIN address_inference.building_parcels bp USING (source_id)
WHERE b.tlid = ANY(%(tlids)s) AND b.dist_m <= 120 AND s.sqmeters >= 50 AND s.prim_occ = ANY(%(homes)s)
ORDER BY b.source_id, b.at_end, b.dist_m
"""


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def validate(dsn, region, town) -> list:
    params = {"region": region.id, "town": town, "state": region.state_abbr}
    with psycopg.connect(dsn) as conn:
        segs = conn.execute(SEGMENTS_SQL, params).fetchall()
        numbers = defaultdict(set)
        for street, n in conn.execute(NUMBERS_SQL, params):
            numbers[(street, int(n) % 2)].add(int(n))
        by_street = defaultdict(list)
        for row in segs:
            by_street[row[0]].append(row)
        claimed = [r[1] for r in segs]
        rows = []
        for street, pieces in by_street.items():
            tlids = [p[1] for p in pieces]
            dup = {r[0] for r in conn.execute(DUPLICATE_SQL, {"tlids": tlids})}
            base = base_name(canonical(street))
            cont = sum(1 for t, name in conn.execute(TOUCHING_SQL, {"tlids": tlids, "claimed": claimed})
                       if base and base_name(canonical(name)) == base)
            lots = defaultdict(set)
            for tlid, side, lot in conn.execute(HOUSES_SQL, {"tlids": tlids, "homes": list(HOMES)}):
                lots[(tlid, side)].add(lot)
            for parity in (0, 1):
                nums = sorted(numbers.get((street, parity), ()))
                if not nums:
                    continue
                ranged, dens, length_all, length_none, houses = [], [], 0.0, 0.0, set()
                crammed = 0
                for _, tlid, _name, lf, lt, rf, rt, length in pieces:
                    length = float(length or 0)
                    length_all += length
                    have = False
                    for side, a, b in (("L", _int(lf), _int(lt)), ("R", _int(rf), _int(rt))):
                        if a is None or b is None or a % 2 != parity or b % 2 != parity:
                            continue
                        have = True
                        ranged.append((min(a, b), max(a, b), tlid))
                        if length > 0:
                            d = max(abs(b - a), 2) / length
                            dens.append(d)
                            crammed += length < CRAMMED_M and d > CRAMMED_PER_M
                        houses |= lots.get((tlid, side), set())
                    if not have:
                        length_none += length
                tiger_top = max((hi for _, hi, _ in ranged), default=None)
                covered = sum(1 for n in nums if any(lo <= n <= hi for lo, hi, _ in ranged))
                placeholder = tiger_top / nums[-1] if tiger_top and nums[-1] else None
                uncovered = 1 - covered / len(nums)
                uneven = max(dens) / min(dens) if len(dens) >= 2 and min(dens) > 0 else 1.0
                one_sided = length_none / length_all if length_all else 0.0
                dup_n = sum(1 for _, _, t in ranged if t in dup)
                gap = abs(len(nums) - len(houses)) / len(nums)
                flags = [name for name, on in (
                    ("placeholder", placeholder is not None and placeholder >= PLACEHOLDER),
                    ("uncovered", uncovered >= UNCOVERED),
                    ("uneven", uneven >= UNEVEN),
                    ("crammed", crammed > 0),
                    ("duplicate", dup_n > 0),
                    ("continuation", cont > 0),
                    ("one_sided", one_sided >= ONE_SIDED),
                ) if on]
                soft = ["houses_gap"] if gap >= HOUSES_GAP else []
                rows.append((region.id, town, street, parity, len(nums), nums[-1], tiger_top, placeholder, uncovered,
                             uneven, crammed, dup_n, cont, one_sided, len(houses), gap, len(flags),
                             ",".join(flags + soft)))
        conn.execute(CREATE_SQL)
        conn.execute("DELETE FROM address_inference.tiger_qa WHERE region_id = %s AND town = %s", (region.id, town))
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO address_inference.tiger_qa VALUES (" + ",".join(["%s"] * 18) + ")", rows)
    return rows


def check(dsn, region, town):
    """Per flag: wrong rate of its numbers on the saved map (method ml_order) vs the town's average."""
    with psycopg.connect(dsn) as conn:
        per = {(s, n): r for s, n, r in conn.execute("""
            SELECT street, address_number, avg((status = 'right')::int) FROM address_inference.ml_predictions
            WHERE town = %s AND method = 'ml_order' AND true_building IS NOT NULL GROUP BY 1, 2""", (town,))}
        qa = conn.execute("SELECT street, parity, flags, score FROM address_inference.tiger_qa "
                          "WHERE region_id = %s AND town = %s", (region.id, town)).fetchall()
    side = {(s, p): (f.split(",") if f else [], sc) for s, p, f, sc in qa}
    total = len(per)
    right = sum(per.values())
    print(f"{town}: {total} numbers, {100 * right / total:.1f}% right on the saved map")
    groups = defaultdict(list)
    for (street, n), r in per.items():
        flags, score = side.get((street, int(n) % 2), ([], 0))
        for f in flags:
            groups[f].append(r)
        groups[f"score {min(score, 2)}{'+' if score >= 2 else ''}"].append(r)
    for g in sorted(groups):
        rs = groups[g]
        print(f"  {g:14s} {len(rs):5d} numbers  {100 * np.mean(rs):5.1f}% right"
              f"  ({100 * (1 - np.mean(rs)) - 100 * (1 - right / total):+.1f} pts wrong vs town)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dsn")
    p.add_argument("region")
    p.add_argument("--town", required=True)
    p.add_argument("--check", action="store_true", help="E911 towns: how well each flag predicts wrong numbers")
    a = p.parse_args()
    region = load_region(a.region)
    rows = validate(a.dsn, region, a.town)
    print(f"{a.town}: {len(rows)} street sides checked, {sum(r[16] > 0 for r in rows)} with a hard flag")
    if a.check:
        check(a.dsn, region, a.town)


if __name__ == "__main__":
    main()
