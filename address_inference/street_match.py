"""Stage 1b: street identification -- which TIGER segments is each label street?

    python -m address_inference.street_match "dbname=geocoding" me --town Freeport

Before a building can be matched to "ROGERS ROAD", we need the TIGER
segments that ARE Rogers Road. Matching by name + ZIP misses a lot
(Freeport: ~19% of E911 addresses, see the design doc), for three
reasons this handles differently:

  1. Spelling: "SOUTH FREEPORT ROAD" vs "S Freeport Rd" -> canonical()
     names on both sides, plus TIGER's aliases (street_names).
  2. ZIP-scoped lookups are fragile (TIGER ZIPs follow USPS delivery
     areas, not town lines) -> ZIP isn't used at all; a name only counts
     where TIGER has it within SEARCH_RADIUS_M of the street's own
     address points ("support").
  3. No TIGER road at all (condo loops, private ways, roads TIGER has
     only as unnamed segments) -> recorded as unmatched, with the reason
     and the nearest TIGER name for diagnosis, never forced onto the
     nearest road.

Writes, replacing the town's previous rows:
  address_inference.street_matches         one row per label street
  address_inference.street_match_segments  label street -> TIGER tlid
"""

import argparse
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher

import psycopg

from .regions import load_region
from .street_names import base_name, canonical

# A TIGER name counts as "near" a label point within this distance.
SEARCH_RADIUS_M = 150
# Exact canonical name: accepted with ANY spatial support (share of the
# street's points with that name nearby). The same name within 150 m of
# the street's own points is strong evidence on its own, and low support
# usually means TIGER's road stops short of the newer houses (Freeport's
# Cortland Rd: 8%), which is worth keeping, not rejecting.
MIN_SUPPORT_EXACT = 0.0
# Same name apart from the suffix word ("ROOS HILL DRIVE" vs "Roos Hill
# Rd", "SOMERSET CONDOS" vs "Somerset"). Often the same road named
# differently by E911 and TIGER -- but sometimes a lane branching off a
# road of the same name, so it's its own method, for later stages to
# trust less.
MIN_SUPPORT_BASE_NAME = 0.5
# Below this share of points with ANY TIGER segment (named or not) nearby,
# an unmatched street is reported as missing from TIGER rather than as a
# naming problem.
MIN_ROAD_COVERAGE = 0.5
# Near-miss spelling ("WOLFS" vs "WOLFES"): needs a close name AND most of
# the street's points beside it, since a fuzzy name alone is weak evidence.
MIN_SIMILARITY_FUZZY = 0.85
MIN_SUPPORT_FUZZY = 0.6

CREATE_TABLES_SQL = """
CREATE SCHEMA IF NOT EXISTS address_inference;
CREATE TABLE IF NOT EXISTS address_inference.street_matches (
    region_id TEXT NOT NULL,
    town TEXT NOT NULL,
    label_street TEXT NOT NULL,
    label_points INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('matched', 'unmatched')),
    method TEXT,                 -- exact | alias | fuzzy | base_name (matched only)
    unmatched_reason TEXT,       -- no_road_nearby | name_mismatch (unmatched only)
    road_coverage DOUBLE PRECISION, -- share of points with any TIGER segment nearby
    tiger_name TEXT,
    name_similarity DOUBLE PRECISION,
    support DOUBLE PRECISION,
    nearest_tiger_name TEXT,     -- most-supported TIGER name, matched or not
    nearest_support DOUBLE PRECISION,
    matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (region_id, town, label_street)
);
CREATE TABLE IF NOT EXISTS address_inference.street_match_segments (
    region_id TEXT NOT NULL,
    town TEXT NOT NULL,
    label_street TEXT NOT NULL,
    tlid TEXT NOT NULL,
    PRIMARY KEY (region_id, town, label_street, tlid)
);
CREATE INDEX IF NOT EXISTS idx_ai_street_match_segments_tlid
    ON address_inference.street_match_segments (tlid);
"""

# Every (label point, TIGER segment within SEARCH_RADIUS_M, one of that
# segment's names) triple for a town. A segment's names are its primary
# fullname plus its street_names aliases; `is_alias` marks the latter.
CANDIDATES_SQL = f"""
SELECT a.id, upper(a.street_fullname), s.tlid, nullif(n.name, ''), n.is_alias
FROM address_points a
JOIN streets s
  ON s.geom && ST_Expand(a.geom, 0.003)
 AND ST_DWithin(s.geom::geography, a.geom::geography, {SEARCH_RADIUS_M})
CROSS JOIN LATERAL (
    SELECT s.fullname AS name, false AS is_alias
    UNION
    SELECT sn.fullname, true FROM street_names sn
    WHERE sn.tlid = s.tlid AND sn.fullname IS DISTINCT FROM s.fullname
) n
WHERE a.town = %(town)s AND a.state_abbr = %(state)s
"""

LABEL_STREETS_SQL = """
SELECT upper(street_fullname), count(*)
FROM address_points
WHERE town = %(town)s AND state_abbr = %(state)s AND street_fullname IS NOT NULL
GROUP BY 1
"""


@dataclass
class StreetMatch:
    label_street: str
    label_points: int
    status: str
    method: str | None = None
    unmatched_reason: str | None = None
    road_coverage: float | None = None
    tiger_name: str | None = None
    name_similarity: float | None = None
    support: float | None = None
    nearest_tiger_name: str | None = None
    nearest_support: float | None = None
    tlids: tuple = ()


def match_street(label_street: str, label_points: int, candidates) -> StreetMatch:
    """Decides one label street from its candidate rows.

    `candidates`: iterable of (point_id, tlid, tiger_name, is_alias) for
    this street's points; tiger_name is None for an unnamed segment (it
    still counts toward road_coverage). Pure function (no DB), so the
    decision rules are unit-testable on their own.
    """
    candidates = list(candidates)
    label_canonical = canonical(label_street)
    label_base = base_name(label_canonical)
    near_any_road = {point_id for point_id, *_ in candidates}
    # canonical TIGER name -> {points supporting it, tlids, display names, primary?}
    by_name = defaultdict(lambda: {"points": set(), "tlids": set(), "names": defaultdict(int), "primary": False})
    for point_id, tlid, tiger_name, is_alias in candidates:
        if not tiger_name:
            continue
        entry = by_name[canonical(tiger_name)]
        entry["points"].add(point_id)
        entry["tlids"].add(tlid)
        entry["names"][tiger_name] += 1
        entry["primary"] |= not is_alias

    def display(entry):
        return max(entry["names"], key=entry["names"].get)

    result = StreetMatch(label_street, label_points, "unmatched")
    result.road_coverage = round(len(near_any_road) / label_points, 3)
    result.unmatched_reason = "no_road_nearby" if result.road_coverage < MIN_ROAD_COVERAGE else "name_mismatch"
    if not by_name:
        return result

    nearest_key = max(by_name, key=lambda k: len(by_name[k]["points"]))
    result.nearest_tiger_name = display(by_name[nearest_key])
    result.nearest_support = len(by_name[nearest_key]["points"]) / label_points

    best = None
    for key, entry in by_name.items():
        similarity = 1.0 if key == label_canonical else SequenceMatcher(None, key, label_canonical).ratio()
        support = len(entry["points"]) / label_points
        if similarity == 1.0 and support >= MIN_SUPPORT_EXACT:
            method = "exact" if entry["primary"] else "alias"
        elif label_base and base_name(key) == label_base:
            # Checked before fuzzy: "ROOS HILL DR" vs "ROOS HILL RD" is also
            # a close spelling, but what differs is the road type, which is
            # exactly the case base_name exists to flag.
            if support < MIN_SUPPORT_BASE_NAME:
                continue
            method = "base_name"
        elif similarity >= MIN_SIMILARITY_FUZZY and support >= MIN_SUPPORT_FUZZY:
            method = "fuzzy"
        else:
            continue
        rank = (similarity, support)
        if best is None or rank > best[0]:
            best = (rank, method, key, entry)

    if best is None:
        return result
    (similarity, support), method, _, entry = best
    result.status = "matched"
    result.unmatched_reason = None
    result.method = method
    result.tiger_name = display(entry)
    result.name_similarity = round(similarity, 3)
    result.support = round(support, 3)
    result.tlids = tuple(sorted(entry["tlids"]))
    return result


def match_town(dsn, region, town: str) -> list[StreetMatch]:
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_TABLES_SQL)
        params = {"town": town, "state": region.state_abbr}
        streets = dict(conn.execute(LABEL_STREETS_SQL, params).fetchall())
        if not streets:
            raise ValueError(f"no label points for town {town!r} in {region.state_abbr}")

        per_street = defaultdict(list)
        for point_id, label_street, tlid, name, is_alias in conn.execute(CANDIDATES_SQL, params):
            per_street[label_street].append((point_id, tlid, name, is_alias))

        matches = [match_street(street, count, per_street.get(street, [])) for street, count in sorted(streets.items())]

        key = {"region": region.id, "town": town}
        conn.execute("DELETE FROM address_inference.street_matches WHERE region_id = %(region)s AND town = %(town)s", key)
        conn.execute("DELETE FROM address_inference.street_match_segments WHERE region_id = %(region)s AND town = %(town)s", key)
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO address_inference.street_matches
                   (region_id, town, label_street, label_points, status, method, unmatched_reason,
                    road_coverage, tiger_name, name_similarity, support, nearest_tiger_name, nearest_support)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                [
                    (region.id, town, m.label_street, m.label_points, m.status, m.method, m.unmatched_reason,
                     m.road_coverage, m.tiger_name, m.name_similarity, m.support, m.nearest_tiger_name,
                     m.nearest_support)
                    for m in matches
                ],
            )
            cur.executemany(
                "INSERT INTO address_inference.street_match_segments VALUES (%s, %s, %s, %s)",
                [(region.id, town, m.label_street, tlid) for m in matches for tlid in m.tlids],
            )
        return matches


def summarize(matches) -> str:
    total_streets = len(matches)
    total_points = sum(m.label_points for m in matches)
    lines = []
    for category in ("exact", "alias", "fuzzy", "base_name", "no_road_nearby", "name_mismatch"):
        group = [m for m in matches if (m.method or m.unmatched_reason) == category]
        points = sum(m.label_points for m in group)
        lines.append(
            f"  {category:<15} {len(group):>5} streets ({len(group) / total_streets:6.1%})"
            f"  {points:>7} addresses ({points / total_points:6.1%})"
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dsn")
    parser.add_argument("region")
    parser.add_argument("--town", required=True, help="e.g. Freeport (as written in the label points)")
    args = parser.parse_args()
    matches = match_town(args.dsn, load_region(args.region), args.town)
    print(f"{args.town}: {len(matches)} label streets")
    print(summarize(matches))


if __name__ == "__main__":
    main()
