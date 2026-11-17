"""Extension streets (owner, 2026-11-17, 8 Sunset Ridge Extension, Harpswell): an E911 street "X Extension" that
TIGER doesn't draw shares street X's line, so it borrowed X's line AND X's range direction -- TIGER counts the even
side from the far end, and 8 landed 442 m away at the wrong end. An extension is a new road continuing past the end
of X, numbered from 1 there.

EXTENSIONS: for an "... EXTENSION" street sharing a TIGER piece with another street (its parent), the extension
starts at the end of the shared line where the parent's own numbers are highest (from the parent's road-order picks
-- predictions, not labels). Its numbers, lowest first, go one each to house-sized buildings nearest that end (and
on past it), within EXT_MAX_M of the end, that no other number holds. Public data only.
"""
from collections import defaultdict

import numpy as np
import psycopg

from .street_lines import street_lines

EXTENSIONS = False
EXT_MAX_M = 200.0
EXT_MIN_M2 = 60.0
EXT_WAY_M = 100.0  # with a mapped way: buildings within this of it

LINE_SQL = "SELECT ST_AsText(ST_StartPoint(g)), ST_AsText(ST_EndPoint(g)), ST_Length(g::geography) FROM street_lines WHERE street = %s"
# The extension's own mapped way (OSM, internal only), if any: houses are ordered along it from the end nearest
# the parent's end (Sunset Ridge Extension: a 93 m way from Sunset Ridge Drive's end; 7 and 8 are 93 m from that
# end alike, across the way from each other -- along the way, 7 comes first).
WAY_SQL = """
SELECT ST_AsText(CASE WHEN ST_Distance(ST_StartPoint(geom), ST_GeomFromText(%(end)s, 4326))
                         <= ST_Distance(ST_EndPoint(geom), ST_GeomFromText(%(end)s, 4326))
                      THEN geom ELSE ST_Reverse(geom) END)
FROM address_inference.osm_drives
WHERE town = %(town)s AND upper(name) = %(name)s
ORDER BY ST_Distance(geom, ST_GeomFromText(%(end)s, 4326)) LIMIT 1
"""
NEAR_SQL = """
SELECT s.source_id,
       CASE WHEN %(way)s::text IS NULL
            THEN ST_Distance(s.inner_point::geography, ST_GeomFromText(%(end)s, 4326)::geography)
            ELSE ST_LineLocatePoint(ST_GeomFromText(%(way)s, 4326), s.inner_point) * 1000
       END AS d,
       greatest(s.sqmeters, coalesce(bl.roof_m2, 0)) AS m2
FROM address_inference.structures s
LEFT JOIN address_inference.building_lidar bl ON bl.state_fips = s.state_fips AND bl.source_id = s.source_id
WHERE s.state_fips = %(state_fips)s AND s.inner_point && ST_Expand(ST_GeomFromText(%(end)s, 4326), 0.003)
  AND ST_DWithin(s.inner_point::geography, ST_GeomFromText(%(end)s, 4326)::geography, %(max)s)
  -- with a mapped way: only buildings beside it (a house 179 m off projected onto its start and sorted first)
  AND (%(way)s::text IS NULL
       OR ST_DWithin(s.inner_point::geography, ST_GeomFromText(%(way)s, 4326)::geography, %(beside)s))
ORDER BY d
"""


def parents(dsn, region, town) -> dict:
    """{extension street label: parent street label} -- extensions sharing a TIGER piece with another street."""
    with psycopg.connect(dsn) as conn:
        rows = conn.execute("""
            SELECT DISTINCT a.label_street, b.label_street FROM address_inference.street_match_segments a
            JOIN address_inference.street_match_segments b ON b.tlid = a.tlid AND b.town = a.town
             AND b.region_id = a.region_id AND b.label_street != a.label_street
            WHERE a.region_id = %s AND a.town = %s AND a.label_street LIKE '%% EXTENSION'
              AND b.label_street NOT LIKE '%% EXTENSION'""", (region.id, town)).fetchall()
    out = {}
    for ext, parent in rows:
        stem = ext[: -len(" EXTENSION")]
        # prefer the parent whose name the extension carries (SUNSET RIDGE -> SUNSET RIDGE DRIVE)
        if ext not in out or parent.startswith(stem):
            out[ext] = parent
    return out


def ext_picks(dsn, region, town, address_df, picks, positions, skip=frozenset()) -> tuple[dict, list]:
    """(picks with extension numbers re-placed, [(extension, parent, {number: source_id})]).
    skip: buildings never to give an extension number (sheds)."""
    if not EXTENSIONS:
        return picks, []
    pmap = parents(dsn, region, town)
    if not pmap:
        return picks, []
    params = {"region": region.id, "town": town, "state_fips": region.state_fips}
    out, found = dict(picks), []
    held = defaultdict(set)  # building -> streets holding it
    for aid, st in zip(address_df["id"], address_df["street"]):
        b = picks.get(aid)
        if b is not None:
            held[b].add(st)
    with psycopg.connect(dsn) as conn:
        street_lines(conn, params)
        for ext, parent in pmap.items():
            prow = address_df[address_df["street"] == parent]
            pts = [(int(n), positions.get((parent, picks.get(a)))) for a, n in zip(prow["id"], prow["number"])]
            pts = [(n, q) for n, q in pts if q is not None]
            line = conn.execute(LINE_SQL, (parent,)).fetchone()
            if len(pts) < 2 or line is None:
                continue
            ns, qs = np.array([p[0] for p in pts], float), np.array([p[1] for p in pts], float)
            if np.std(ns) == 0 or np.std(qs) == 0:
                continue
            start, end, _length = line
            # the parent's numbers rise toward the line's end -> the extension begins at the end, else at the start
            begin = end if np.corrcoef(ns, qs)[0, 1] > 0 else start
            name = ext.replace(" EXTENSION", " Extension").title().upper()
            way_row = conn.execute(WAY_SQL, {"end": begin, "town": town, "name": name}).fetchone()
            way = way_row[0] if way_row else None
            homes = [(sid, d) for sid, d, m2 in conn.execute(NEAR_SQL, {**params, "end": begin, "max": EXT_MAX_M,
                                                                         "way": way, "beside": EXT_WAY_M})
                     if (m2 or 0) >= EXT_MIN_M2 and sid not in skip and not (held[sid] - {ext})]
            erows = address_df[address_df["street"] == ext]
            numbers = sorted({int(n) for n in erows["number"]})
            if not numbers or len(homes) < len(numbers):
                continue
            chosen = {n: sid for n, (sid, _d) in zip(numbers, homes)}
            for a, n in zip(erows["id"], erows["number"]):
                out[a] = chosen[int(n)]
            found.append((ext, parent, chosen))
    return out, found
