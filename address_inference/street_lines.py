"""One line per Stage 1b street, for measuring "meters along the street".

ST_LineMerge(ST_Union(...)) of a street's TIGER pieces is a single
LineString only when the pieces form one unbranched chain. A fork, a short
spur, or a gap leaves a MultiLineString, and every query that needed one
line used to skip the street entirely -- road order then never ran there
(Harpswell: 61 of 539 streets, 949 of 3,984 numbers; Ash Point Road, whose
TIGER pieces have two short spurs, lost 16-24's order and fell back to the
ranker's picks: 20 and 24 took their neighbors' houses).

street_lines(conn, params) fills a TEMP table `street_lines (street, g)`
on `conn`: a street that merges keeps PostGIS's own merged line unchanged;
otherwise short spurs hanging off a fork are trimmed (shortest first, each
at most SPUR_MAX_SHARE of the street) and the remaining pieces are chained
end to end, nearest ends first, starting from the longest piece."""

from collections import Counter

from shapely import wkb
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge

from .extend_lines import ensure_view

# A spur (one end free, the other at a fork) is trimmed only when it is at
# most this share of the street's total length -- a lollipop's long access
# road is not a spur.
SPUR_MAX_SHARE = 0.25
# False = the old behavior (a street that doesn't merge gets no line), for A/B runs.
JOIN_PIECES = True

LINES_SQL = """
SELECT sms.label_street, ST_AsBinary(ST_LineMerge(ST_Union(s.geom)))
FROM address_inference.street_match_segments sms
JOIN address_inference.streets_ext s ON s.tlid = sms.tlid
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
GROUP BY sms.label_street
"""


def _key(pt):
    return (round(pt[0], 7), round(pt[1], 7))


def _trim_spurs(parts):
    total = sum(p.length for p in parts)
    while len(parts) > 1:
        deg = Counter()
        for p in parts:
            deg[_key(p.coords[0])] += 1
            deg[_key(p.coords[-1])] += 1
        spurs = [p for p in parts
                 if sorted((deg[_key(p.coords[0])], deg[_key(p.coords[-1])])) [0] == 1
                 and max(deg[_key(p.coords[0])], deg[_key(p.coords[-1])]) >= 3
                 and p.length <= SPUR_MAX_SHARE * total]
        if not spurs:
            break
        parts.remove(min(spurs, key=lambda p: p.length))
        merged = linemerge(parts)
        parts = [merged] if isinstance(merged, LineString) else list(merged.geoms)
    return parts


def _chain(parts):
    parts = sorted(parts, key=lambda p: -p.length)
    coords = list(parts[0].coords)
    rest = parts[1:]
    while rest:
        head, tail = coords[0], coords[-1]
        best = None
        for i, p in enumerate(rest):
            a, b = p.coords[0], p.coords[-1]
            for d, where, rev in ((_d2(tail, a), "tail", False), (_d2(tail, b), "tail", True),
                                  (_d2(head, b), "head", False), (_d2(head, a), "head", True)):
                if best is None or d < best[0]:
                    best = (d, i, where, rev)
        _, i, where, rev = best
        pc = list(rest.pop(i).coords)
        if rev:
            pc.reverse()
        coords = coords + pc if where == "tail" else pc + coords
    return LineString(coords)


def _d2(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def single_line(geom):
    """A LineString through a street's merged pieces (see module doc)."""
    if geom is None or geom.is_empty:
        return None
    if isinstance(geom, LineString):
        return geom
    if not JOIN_PIECES:
        return None
    parts = list(geom.geoms) if isinstance(geom, MultiLineString) else []
    parts = [p for p in parts if isinstance(p, LineString) and not p.is_empty]
    if not parts:
        return None
    parts = _trim_spurs(parts)
    return parts[0] if len(parts) == 1 else _chain(parts)


def street_lines(conn, params) -> None:
    """Create/refresh TEMP table street_lines (street, g) for params' town."""
    ensure_view(conn)
    rows = conn.execute(LINES_SQL, params).fetchall()
    conn.execute("DROP TABLE IF EXISTS pg_temp.street_lines")
    conn.execute("CREATE TEMP TABLE street_lines (street text PRIMARY KEY, g geometry(LineString, 4326))")
    with conn.cursor() as cur:
        out = []
        for street, g in rows:
            line = single_line(wkb.loads(bytes(g))) if g is not None else None
            if line is not None:
                out.append((street, line.wkb))
        cur.executemany("INSERT INTO street_lines VALUES (%s, ST_SetSRID(ST_GeomFromWKB(%s), 4326))", out)
    conn.execute("CREATE INDEX ON street_lines USING gist (g)")
    conn.execute("ANALYZE street_lines")


LINES_CTE = "lines AS (SELECT street, g FROM street_lines)"
