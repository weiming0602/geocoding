"""Extends a street's TIGER line where the road goes on past TIGER's dead end.

Harpswell's Bayview Road: TIGER's line stops 40 m into its last piece (even
200-298), while the road goes on as the Bowdoin College campus drive, one
tax lot, and its houses (240-283) sit up to 450 m beyond. Road order had no
line there, left them unplaced, and the ranker sent four of them to one
building 640-790 m away.

A dead end of a matched, ranged TIGER piece is extended along OSM's drivable
ways (named or not, from address_inference.osm_drives -- internal only, ODbL,
never streets/street_names) that start within END_NEAR_M of it and don't lie
along a named TIGER road, to the farthest point reachable within MAX_EXTEND_M,
when at least MIN_FAR_BUILDINGS buildings lie within BUILDING_NEAR_M of that
drive and more than FAR_FROM_TIGER_M from every named TIGER road (houses no
TIGER road can reach). No E911 point is looked at. Harpswell: only Bayview
qualifies (9 such buildings; the next dead end has 2).

The extended line is kept in address_inference.line_extensions (tlid ->
extended geom); address_inference.streets_ext is streets with that geometry
swapped in, read by attach / dataset / order / street_lines. The extension is
added at the dead end, so the range's own end there stays at the far end of
the extension (Bayview: 298 at the campus end, 200 where the drive leaves).

Usage: python -m address_inference.extend_lines "dbname=geocoding" me --town Harpswell
(needs data/session_2026-11-14_extend/osm_drives.py run for the town first).
"""
import argparse
import heapq
import math

import psycopg
from shapely import wkt
from shapely.geometry import LineString

from address_inference.regions import load_region

END_NEAR_M = 15
MAX_EXTEND_M = 1500
MIN_EXTEND_M = 50
MIN_FAR_BUILDINGS = 3
BUILDING_NEAR_M = 60
FAR_FROM_TIGER_M = 100
ALONG_TIGER_M = 12  # a drive lying (half or more) within this of a named TIGER road is that road

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS address_inference.line_extensions (
    region_id text NOT NULL, town text NOT NULL, tlid text NOT NULL,
    street text, added_m double precision, far_buildings integer,
    geom geometry(LineString, 4326) NOT NULL,
    PRIMARY KEY (region_id, town, tlid));
CREATE OR REPLACE VIEW address_inference.streets_ext AS
SELECT s.id, s.tlid, s.fullname, s.lfromadd, s.ltoadd, s.rfromadd, s.rtoadd, s.zipl, s.zipr,
       s.mtfcc, s.statefp, s.countyfp, s.state, s.state_abbr,
       CASE WHEN e.geom IS NULL THEN s.geometry ELSE ST_AsText(e.geom) END AS geometry,
       s.minx, s.miny, s.maxx, s.maxy, coalesce(e.geom, s.geom) AS geom, s.tnidf, s.tnidt
FROM streets s
LEFT JOIN (SELECT DISTINCT ON (tlid) tlid, geom FROM address_inference.line_extensions ORDER BY tlid, town) e
  ON e.tlid = s.tlid;
"""

DEAD_ENDS_SQL = """
SELECT sms.label_street, s.tlid, e.which, ST_X(e.pt), ST_Y(e.pt), ST_AsText(s.geom)
FROM address_inference.street_match_segments sms JOIN streets s ON s.tlid = sms.tlid
CROSS JOIN LATERAL (VALUES ('start', ST_StartPoint(s.geom)), ('end', ST_EndPoint(s.geom))) e(which, pt)
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
  AND (coalesce(s.lfromadd, '') <> '' OR coalesce(s.rfromadd, '') <> '')
  AND NOT EXISTS (SELECT 1 FROM streets o WHERE o.tlid <> s.tlid AND o.geom && ST_Expand(e.pt, 0.0002)
                  AND ST_DWithin(o.geom::geography, e.pt::geography, 3))
"""

FREE_DRIVES_SQL = f"""
SELECT ST_AsText(d.geom) FROM address_inference.osm_drives d WHERE d.town = %(town)s
  AND coalesce(ST_Length(ST_Intersection(d.geom, (
        SELECT ST_Union(ST_Buffer(o.geom::geography, {ALONG_TIGER_M})::geometry) FROM streets o
        WHERE o.geom && ST_Expand(d.geom, 0.0003) AND coalesce(o.fullname, '') <> ''))::geography), 0)
      < 0.5 * ST_Length(d.geom::geography)
"""

FAR_BUILDINGS_SQL = f"""
SELECT count(*) FROM address_inference.structures b
WHERE b.inner_point && ST_Expand(ST_GeomFromText(%(g)s, 4326), 0.001)
  AND ST_DWithin(b.inner_point::geography, ST_GeomFromText(%(g)s, 4326)::geography, {BUILDING_NEAR_M})
  AND NOT EXISTS (SELECT 1 FROM streets o WHERE coalesce(o.fullname, '') <> ''
                  AND o.geom && ST_Expand(b.inner_point, 0.002)
                  AND ST_DWithin(o.geom::geography, b.inner_point::geography, {FAR_FROM_TIGER_M}))
"""


def ensure_view(conn):
    """line_extensions + the streets_ext view (empty table = plain streets)."""
    conn.execute(CREATE_SQL)


def _m(a, b):
    return math.hypot((a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)) * 111320,
                      (a[1] - b[1]) * 110540)


def _key(p):
    return (round(p[0], 7), round(p[1], 7))


def drive_graph(drive_wkts):
    graph = {}
    for w in drive_wkts:
        cs = [_key(p) for p in wkt.loads(w).coords]
        for a, b in zip(cs, cs[1:]):
            d = _m(a, b)
            graph.setdefault(a, []).append((b, d))
            graph.setdefault(b, []).append((a, d))
    return graph


def farthest_path(graph, start, max_m=MAX_EXTEND_M):
    """The path from start to the node farthest along the drives (within max_m)."""
    dist, prev, pq = {start: 0.0}, {}, [(0.0, start)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, w in graph[u]:
            if d + w <= max_m and d + w < dist.get(v, math.inf):
                dist[v], prev[v] = d + w, u
                heapq.heappush(pq, (d + w, v))
    far = max(dist, key=dist.get)
    path = [far]
    while path[-1] != start:
        path.append(prev[path[-1]])
    return path[::-1], dist[far]


def extended_line(piece: LineString, which: str, path) -> LineString:
    """piece with path (starting at its dead end) added at that end."""
    cs = list(piece.coords)
    if which == "start":
        return LineString(list(reversed(path)) + cs)
    return LineString(cs + path)


def find_extensions(conn, region_id, town):
    params = {"region": region_id, "town": town}
    graph = drive_graph([r[0] for r in conn.execute(FREE_DRIVES_SQL, params)])
    nodes = list(graph)
    found = []
    for street, tlid, which, x, y, piece in conn.execute(DEAD_ENDS_SQL, params).fetchall():
        near = [n for n in nodes if abs(n[1] - y) < 0.0003 and _m(n, (x, y)) <= END_NEAR_M]
        if not near:
            continue
        path, length = farthest_path(graph, min(near, key=lambda n: _m(n, (x, y))))
        if length < MIN_EXTEND_M:
            continue
        drive = LineString(path).wkt
        far = conn.execute(FAR_BUILDINGS_SQL, {"g": drive}).fetchone()[0]
        if far >= MIN_FAR_BUILDINGS:
            found.append((street, tlid, length, far, extended_line(wkt.loads(piece), which, path)))
    return found


def extend(dsn, region, town, progress=print):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_SQL)
        conn.execute("DELETE FROM address_inference.line_extensions WHERE region_id = %s AND town = %s",
                     (region.id, town))
        found = find_extensions(conn, region.id, town)
        for street, tlid, length, far, line in found:
            conn.execute("INSERT INTO address_inference.line_extensions VALUES (%s,%s,%s,%s,%s,%s,ST_GeomFromText(%s,4326))",
                         (region.id, town, tlid, street, length, far, line.wkt))
            progress(f"  {street}: TIGER {tlid} extended {length:.0f} m ({far} buildings past TIGER's roads)")
        conn.commit()
        return len(found)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dsn")
    p.add_argument("region")
    p.add_argument("--town", required=True)
    a = p.parse_args()
    print(extend(a.dsn, load_region(a.region), a.town), "pieces extended")


if __name__ == "__main__":
    main()
