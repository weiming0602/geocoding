"""Stage 3 data: one row per (address, candidate building), with features,
the E911 label, and the geometry baselines (M0-M2) computed alongside.

For each E911 address on a street Stage 1b matched to TIGER:

  covering range   the street segment + side whose TIGER range holds the
                   house number (same parity), and the number's fraction f
                   along it. No covering range = the address isn't scorable
                   by any TIGER-based method (counted, not dropped silently).
  M0               today's interpolation: f along that segment, offset 20 ft
                   to that side (geocoding/interpolate.py's own function).
  candidates       buildings Stage 2 attached to any of the street's
                   segments, nearest MAX_CANDIDATES to M0.
  true building    the footprint containing the E911 point, else the nearest
                   one within TRUE_BUILDING_RADIUS_M, else none.

Only TIGER + footprints feed the features; E911 supplies the label and
nothing else.
"""

from collections import defaultdict

import numpy as np
import pandas as pd
import psycopg

from geocoding.interpolate import interpolate_along_line, parse_linestring

MAX_CANDIDATES = 50
TRUE_BUILDING_RADIUS_M = 30
OFFSET_FEET = 20  # same as geocoding-server's default OFFSET_FEET
# Buildings this close to a bigger building nearer the road are likely its
# garage/barn: the "bigger building in front" feature.
OUTBUILDING_RADIUS_M = 40

ADDRESSES_SQL = """
SELECT a.site_uid, a.address_number, sm.label_street, sm.method,
       ST_Y(a.geom), ST_X(a.geom), tb.source_id
FROM address_points a
JOIN address_inference.street_matches sm
  ON sm.region_id = %(region)s AND sm.town = a.town AND sm.label_street = upper(a.street_fullname)
 AND sm.status = 'matched'
LEFT JOIN LATERAL (
    SELECT s.source_id FROM address_inference.structures s
    WHERE s.state_fips = %(state_fips)s
      AND s.geom && ST_Expand(a.geom, 0.0005)
      AND ST_DWithin(s.geom::geography, a.geom::geography, %(radius)s)
    ORDER BY ST_Distance(s.geom::geography, a.geom::geography), s.source_id
    LIMIT 1
) tb ON true
WHERE a.town = %(town)s AND a.state_abbr = %(state)s AND a.address_number > 0
ORDER BY a.site_uid
"""

SEGMENTS_SQL = """
SELECT sms.label_street, st.tlid, st.lfromadd, st.ltoadd, st.rfromadd, st.rtoadd, st.geometry,
       ST_Length(st.geom::geography),
       -- Dead ends: a segment end no other road touches (within 2 m).
       NOT EXISTS (SELECT 1 FROM streets o WHERE o.tlid <> st.tlid
                     AND o.geom && ST_Expand(ST_StartPoint(st.geom), 0.0001)
                     AND ST_DWithin(o.geom::geography, ST_StartPoint(st.geom)::geography, 2)) AS dead_start,
       NOT EXISTS (SELECT 1 FROM streets o WHERE o.tlid <> st.tlid
                     AND o.geom && ST_Expand(ST_EndPoint(st.geom), 0.0001)
                     AND ST_DWithin(o.geom::geography, ST_EndPoint(st.geom)::geography, 2)) AS dead_end
FROM address_inference.street_match_segments sms
JOIN streets st ON st.tlid = sms.tlid
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
ORDER BY sms.label_street, st.tlid
"""

# Every building attached to a matched street's segments, with its own
# nearest road (any street) for the "is this street even its nearest?" features.
CANDIDATES_SQL = """
SELECT sms.label_street, bs.source_id, bs.tlid, bs.side, bs.t, bs.at_end, bs.dist_m,
       s.sqmeters, s.occ_cls, s.prim_occ, s.outbldg, ST_Y(s.inner_point), ST_X(s.inner_point),
       nearest.tlid AS nearest_tlid, nearest.dist_m AS nearest_dist_m
FROM address_inference.street_match_segments sms
JOIN address_inference.building_segments bs ON bs.tlid = sms.tlid AND bs.state_fips = %(state_fips)s
JOIN address_inference.structures s
  ON s.state_fips = bs.state_fips AND s.source = bs.source AND s.source_id = bs.source_id
JOIN address_inference.building_segments nearest
  ON nearest.state_fips = bs.state_fips AND nearest.source = bs.source
 AND nearest.source_id = bs.source_id AND nearest.rank = 1
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
ORDER BY sms.label_street, bs.source_id, bs.tlid, nearest.tlid
"""


# A building past the end of its street (every attachment to the street at
# a segment end) within this angle of the road's continuing direction is
# "beyond the end": its left/right side is a coin flip decided by the last
# few meters of the line, so it counts for either side. Dead ends are
# where E911 and TIGER lines often stop short of the last house
# (Arrowhead Ridge Road's 9 is ~100 m past E911's line).
BEYOND_END_MAX_ANGLE_DEG = 45


# How a house past a dead end gets its side:
#   "either"    -- it counts for both sides (the ordering and scores decide);
#   "axis"      -- its side of the straight line from the segment's start
#                  to its end (the street's overall direction, not the
#                  last few meters of the line);
#   "neighbors" -- the side of its two nearest same-street houses that
#                  aren't past the end.
DEAD_END_SIDE = "axis"


def side_of_chord(points, lat, lon) -> str:
    """'L' or 'R' of the straight line from the first to the last point."""
    (ax, ay), (bx, by) = points[0], points[-1]
    k = np.cos(np.radians(ay))
    cross = (bx - ax) * k * (lat - ay) - (by - ay) * (lon - ax) * k
    return "L" if cross > 0 else "R"


def beyond_end(points, t, lat, lon) -> bool:
    """Is (lat, lon) ahead of the segment's end at t (0 or 1), inside
    BEYOND_END_MAX_ANGLE_DEG of the line's direction there?"""
    if t not in (0, 1) or len(points) < 2:
        return False
    (ax, ay), (bx, by) = (points[-2], points[-1]) if t == 1 else (points[1], points[0])
    kx = np.cos(np.radians(by))  # degrees of longitude are shorter by cos(lat)
    dx, dy = (bx - ax) * kx, by - ay
    vx, vy = (lon - bx) * kx, lat - by
    norm = np.hypot(dx, dy)
    if norm == 0:
        return False
    forward = (vx * dx + vy * dy) / norm
    lateral = abs(vx * dy - vy * dx) / norm
    return forward > 0 and lateral <= forward * np.tan(np.radians(BEYOND_END_MAX_ANGLE_DEG))


def haversine_m(lat1, lon1, lat2, lon2):
    """Meters; works on scalars or numpy arrays."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6_371_000 * np.arcsin(np.sqrt(a))


def _int_or_none(value):
    return int(value) if value and str(value).isdigit() else None


def covering_range(number: int, segments):
    """(segment, side 'L'/'R', fraction f, range size) whose range holds
    `number` with the range's own parity -- or None. When several ranges
    cover it (overlapping TIGER ranges), the tightest one wins."""
    best = None
    for seg in segments:
        for side, lo_key, hi_key in (("L", "lfromadd", "ltoadd"), ("R", "rfromadd", "rtoadd")):
            start, end = _int_or_none(seg[lo_key]), _int_or_none(seg[hi_key])
            if start is None or end is None:
                continue
            if not min(start, end) <= number <= max(start, end):
                continue
            if start % 2 == end % 2 and number % 2 != start % 2:
                continue  # wrong parity for this side's range
            fraction = 0.5 if start == end else (number - start) / (end - start)
            span = abs(end - start)
            # Tightest range wins; equal spans go to the lowest tlid, so the
            # answer never depends on the order segments arrive in.
            if best is None or (span, str(seg["tlid"])) < (best[3], str(best[0]["tlid"])):
                best = (seg, side, fraction, span)
    return best


# Each candidate building's tax parcel (address_inference.parcels): the
# lot's frontage on each street segment, how many buildings share the lot,
# and which is the biggest. Empty when parcels aren't loaded.
PARCELS_SQL = """
SELECT bp.source_id, bp.parcel_id, ST_Area(p.geom::geography),
       count(*) OVER (PARTITION BY bp.parcel_id),
       s.sqmeters = max(s.sqmeters) OVER (PARTITION BY bp.parcel_id),
       s.sqmeters / nullif(max(s.sqmeters) OVER (PARTITION BY bp.parcel_id), 0)
FROM address_inference.building_parcels bp
JOIN address_inference.parcels p ON p.parcel_id = bp.parcel_id AND p.state_fips = bp.state_fips
JOIN address_inference.structures s ON s.state_fips = bp.state_fips AND s.source_id = bp.source_id
WHERE bp.state_fips = %(state_fips)s AND p.town = %(town)s
ORDER BY bp.source_id
"""
FRONTAGE_SQL = """
SELECT pf.parcel_id, pf.tlid, pf.frontage_m
FROM address_inference.parcel_frontage pf
JOIN address_inference.parcels p ON p.parcel_id = pf.parcel_id
WHERE p.town = %(town)s AND p.state_fips = %(state_fips)s
ORDER BY pf.parcel_id, pf.tlid
"""


# Optional per-building details: address_inference.building_pool (a pool
# near the building -- a home, not a barn; owner's rule) when loaded.
POOLS_SQL = "SELECT source_id, d FROM address_inference.building_pool"


def load_pools(conn) -> dict:
    if conn.execute("SELECT to_regclass('address_inference.building_pool') IS NULL").fetchone()[0]:
        return {}
    return {sid: d for sid, d in conn.execute(POOLS_SQL).fetchall()}


def load_parcels(conn, params) -> dict | None:
    if conn.execute("SELECT to_regclass('address_inference.building_parcels') IS NULL").fetchone()[0]:
        return None
    buildings = {sid: {"parcel": pid, "area": area, "buildings": n, "largest": bool(largest),
                       "size_ratio": ratio}
                 for sid, pid, area, n, largest, ratio in conn.execute(PARCELS_SQL, params).fetchall()}
    frontage = defaultdict(dict)
    for pid, tlid, m in conn.execute(FRONTAGE_SQL, params).fetchall():
        frontage[pid][tlid] = m
    return {"buildings": buildings, "frontage": dict(frontage)} if buildings else None


def load(dsn, region, town: str):
    params = {"region": region.id, "town": town, "state": region.state_abbr,
              "state_fips": region.state_fips, "radius": TRUE_BUILDING_RADIUS_M}
    with psycopg.connect(dsn) as conn:
        addresses = conn.execute(ADDRESSES_SQL, params).fetchall()
        segments = conn.execute(SEGMENTS_SQL, params).fetchall()
        candidates = conn.execute(CANDIDATES_SQL, params).fetchall()
        parcels = load_parcels(conn, params)
        if parcels is not None:
            parcels["pools"] = load_pools(conn)
    return addresses, segments, candidates, parcels


def tiger_span(segments, parity):
    """(lowest, highest) TIGER number on any range that can hold `parity`
    across a street's segments, or None."""
    ends = []
    for seg in segments:
        for lo_key, hi_key in (("lfromadd", "ltoadd"), ("rfromadd", "rtoadd")):
            start, end = _int_or_none(seg[lo_key]), _int_or_none(seg[hi_key])
            if start is None or end is None:
                continue
            if start % 2 == end % 2 and start % 2 != parity:
                continue
            ends += [start, end]
    return (min(ends), max(ends)) if ends else None


# ranges='auto': the list's scale replaces TIGER's only when TIGER's range
# on that street side runs at least this many times past the list's
# highest number -- a placeholder range like Arrowhead Ridge Road's 1-99
# for real numbers 1-9. Where TIGER's ranges track the real numbers
# (Flying Point Road: 55 segments, 153-155, 157-161, ...), they're kept.
AUTO_INFLATION = 2.0
# ...and only when the side's numbers are SEQUENTIAL (subdivision-style
# 1, 3, 5, 7, 9: few gaps), not distance-based (Brickyard Cove's 12, 22,
# 42, 44). Distance-based numbers mark position along the road, so TIGER's
# wide range can be right even when the houses stop early. Density = how
# many of the parity's slots between min and max are taken.
AUTO_MIN_DENSITY = 0.7


def list_range_number(number, side_numbers, segments, min_inflation=None):
    """`number` moved onto TIGER's numbering by its place in the LIST's own
    min..max for its side (parity): the list sets the scale, TIGER only
    says which segment comes first and which side holds the parity. With
    fewer than two distinct numbers on the side there's no scale: the
    number is used as-is (TIGER's range)."""
    lo, hi = side_numbers[0], side_numbers[-1]
    span = tiger_span(segments, number % 2)
    if hi == lo or span is None:
        return number
    t_lo, t_hi = span
    if min_inflation is not None:
        density = len(side_numbers) / ((hi - lo) / 2 + 1)
        if t_hi < min_inflation * hi or density < AUTO_MIN_DENSITY:
            return number  # TIGER's range is believable here
    eq = t_lo + (number - lo) / (hi - lo) * (t_hi - t_lo)
    eq = int(round(eq))
    if eq % 2 != number % 2:  # keep the parity so covering_range finds the right side
        eq += 1 if eq < t_hi else -1
    return min(max(eq, t_lo), t_hi)


def build(addresses, segments, candidates, parcels=None, ranges="tiger"):
    """Returns (address_df, candidate_df). Pure: takes the rows load()
    returns, so it's testable without a database.

    ranges='tiger': a number's place along the street comes from TIGER's
    address ranges. ranges='auto': the list's scale only where TIGER's
    range looks like a placeholder (AUTO_INFLATION). ranges='list': from its place among the list's own
    numbers on that street side (min..max of `addresses`) -- TIGER's
    numbers, often far wider than the real ones (Arrowhead Ridge Road:
    1-99 vs 1-9), are never used for scale."""
    seg_keys = ("label_street", "tlid", "lfromadd", "ltoadd", "rfromadd", "rtoadd", "geometry", "length_m",
                "dead_start", "dead_end")
    segs_by_street = defaultdict(list)
    for row in segments:
        seg = dict(zip(seg_keys, row))
        seg["points"] = parse_linestring(seg["geometry"])
        segs_by_street[seg["label_street"]].append(seg)

    cand_keys = ("label_street", "source_id", "tlid", "side", "t", "at_end", "dist_m", "sqmeters", "occ_cls",
                 "prim_occ", "outbldg", "lat", "lon", "nearest_tlid", "nearest_dist_m")
    cands_by_street = defaultdict(list)
    for row in candidates:
        cand = dict(zip(cand_keys, row))
        cands_by_street[cand["label_street"]].append(cand)

    side_numbers = defaultdict(set)
    for _, number, street, *_rest in addresses:
        side_numbers[(street, number % 2)].add(number)
    side_numbers = {key: sorted(nums) for key, nums in side_numbers.items()}

    address_rows, cand_rows = [], []
    for site_uid, number, street, method, lat, lon, true_id in addresses:
        street_segs = segs_by_street.get(street, [])
        if ranges == "tiger":
            range_number = number
        else:
            range_number = list_range_number(number, side_numbers[(street, number % 2)], street_segs,
                                             AUTO_INFLATION if ranges == "auto" else None)
        cover = covering_range(range_number, street_segs)
        addr = {"id": site_uid, "number": number, "range_number": range_number, "street": street, "match_method": method, "true_lat": lat, "true_lon": lon,
                "true_building": true_id, "scorable": cover is not None}
        if cover is None:
            address_rows.append(addr)
            continue
        seg, side, fraction, span = cover
        m0_lon, m0_lat = interpolate_along_line(seg["points"], fraction, OFFSET_FEET,
                                                "left" if side == "L" else "right")
        addr.update(m0_lat=m0_lat, m0_lon=m0_lon, cover_tlid=seg["tlid"], cover_side=side, f=fraction)
        address_rows.append(addr)
        cand_rows.extend(_candidates_for(addr, seg, side, fraction, span, street_segs, cands_by_street[street],
                                         parcels))

    address_df = pd.DataFrame(address_rows)
    candidate_df = pd.DataFrame(cand_rows)
    if not candidate_df.empty:
        candidate_df["label"] = (candidate_df["source_id"] == candidate_df["true_building"]).astype(int)
    return address_df, candidate_df


def _parcel_features(source_id, street_tlids, parcels) -> dict:
    """The building's lot: frontage (m) on this street's segments vs. on
    other streets', the share on this street, buildings on the lot, and
    whether this is the lot's biggest. NaN without a parcel."""
    info = parcels["buildings"].get(source_id) if parcels else None
    if info is None:
        return {"parcel_frontage_this": np.nan, "parcel_frontage_other": np.nan, "parcel_frontage_share": np.nan,
                "parcel_buildings": np.nan, "parcel_largest": np.nan, "parcel_area_m2": np.nan,
                "parcel_size_ratio": np.nan}
    front = parcels["frontage"].get(info["parcel"], {})
    this = sum(m for tlid, m in front.items() if tlid in street_tlids)
    other = sum(m for tlid, m in front.items() if tlid not in street_tlids)
    return {"parcel_frontage_this": this, "parcel_frontage_other": other,
            "parcel_frontage_share": this / (this + other) if this + other > 0 else np.nan,
            "parcel_buildings": info["buildings"], "parcel_largest": float(info["largest"]),
            "parcel_area_m2": info["area"],
            # This building's size vs. the lot's biggest: a shed is a small
            # fraction (12 Brickyard Cove's lot: 297 m2 house, 45 m2 shed).
            "parcel_size_ratio": info.get("size_ratio", np.nan) if info.get("size_ratio") is not None else np.nan}


def _candidates_for(addr, cover_seg, side, fraction, span, street_segs, street_cands, parcels=None):
    range_start = int(cover_seg["lfromadd" if side == "L" else "rfromadd"])
    street_tlids = {s["tlid"] for s in street_segs}
    points_by_tlid = {s["tlid"]: s["points"] for s in street_segs}
    # Which ends are dead ends (unknown -- e.g. rows without the flags -- counts as one).
    dead_by_tlid = {s["tlid"]: (s.get("dead_start", True), s.get("dead_end", True)) for s in street_segs}
    by_building = defaultdict(list)
    for cand in street_cands:
        by_building[cand["source_id"]].append(cand)
    if not by_building:
        return []

    # Same-side buildings along the covering segment, in t order: the rank-
    # order (M2) view. t runs from the segment's first vertex, which is
    # where its `from` number sits, so rank fraction compares to f directly.
    on_side = sorted(
        (c for cands in by_building.values() for c in cands
         if c["tlid"] == cover_seg["tlid"] and c["side"] == side and not c["at_end"]),
        key=lambda c: (c["t"], c["source_id"]),
    )
    rank_frac = {c["source_id"]: (i + 0.5) / len(on_side) for i, c in enumerate(on_side)}
    implied_addresses = span / 2 + 1

    # Pass 1: each building's nearest segment of this street, and whether
    # it's past a dead end.
    info = {}
    for source_id, cands in by_building.items():
        # This building's nearest segment OF THIS STREET. A building by the
        # joint of two segments is equally near both: prefer the one it sits
        # alongside over one it only touches at an end, then the lowest tlid.
        best = min(cands, key=lambda c: (round(c["dist_m"], 2), bool(c["at_end"]), str(c["tlid"])))
        on_cover = next((c for c in cands if c["tlid"] == cover_seg["tlid"]), None)
        dead_start, dead_end = dead_by_tlid.get(best["tlid"], (False, False))
        at_dead_end = (best["t"] == 0 and dead_start) or (best["t"] == 1 and dead_end)
        past_end = all(c["at_end"] for c in cands) and at_dead_end and beyond_end(
            points_by_tlid.get(best["tlid"], []), best["t"], best["lat"], best["lon"])
        own_side = on_cover["side"] if on_cover else best["side"]
        info[source_id] = (best, on_cover, past_end, own_side)

    def dead_end_side(source_id):
        best, on_cover, _, own_side = info[source_id]
        if DEAD_END_SIDE == "axis":
            pts = points_by_tlid.get(cover_seg["tlid"] if on_cover else best["tlid"], [])
            return side_of_chord(pts, best["lat"], best["lon"]) if len(pts) >= 2 else own_side
        if DEAD_END_SIDE == "neighbors":
            others = sorted(
                (float(haversine_m(best["lat"], best["lon"], b["lat"], b["lon"])), sd)
                for sid, (b, _oc, pe, sd) in info.items() if sid != source_id and not pe and sd)
            sides = [sd for _, sd in others[:2]]
            return max(set(sides), key=sides.count) if sides else own_side
        return None  # "either"

    rows = []
    for source_id, cands in by_building.items():
        best, on_cover, past_end, own_side = info[source_id]
        if past_end:
            # Past the street's dead end: the line's last few meters can't
            # say which side it's on (DEAD_END_SIDE).
            decided = dead_end_side(source_id)
            same_side = True if decided is None else decided == side
        else:
            same_side = own_side == side
        d_m0 = float(haversine_m(addr["m0_lat"], addr["m0_lon"], best["lat"], best["lon"]))
        rows.append({
            "address_id": addr["id"],
            "street": addr["street"],
            "source_id": source_id,
            "true_building": addr["true_building"],
            "lat": best["lat"], "lon": best["lon"],
            # --- features ---
            "d_m0": d_m0,
            "on_cover_segment": on_cover is not None,
            "same_side": same_side,
            "beyond_end": past_end,
            "dt": abs(on_cover["t"] - fraction) * cover_seg["length_m"] if on_cover else np.nan,
            # Raw "how far along" vs "how many numbers along" from the range's
            # start: lets the model learn the local numbering density instead
            # of assuming the range is spread evenly over the segment (M0).
            "pos_m": on_cover["t"] * cover_seg["length_m"] if on_cover else np.nan,
            "numbers_from_start": abs(addr["range_number"] - range_start),
            "meters_per_number": (on_cover["t"] * cover_seg["length_m"] / abs(addr["range_number"] - range_start)
                                  if on_cover and addr["range_number"] != range_start else np.nan),
            "rank_gap": abs(rank_frac[source_id] - fraction) if source_id in rank_frac else np.nan,
            "buildings_on_side": len(on_side),
            "implied_addresses": implied_addresses,
            "dist_road": best["dist_m"],
            "at_end": bool(best["at_end"]),
            "nearest_road_is_street": best["nearest_tlid"] in street_tlids,
            "dist_vs_nearest_road": best["dist_m"] - best["nearest_dist_m"],
            "sqmeters": best["sqmeters"],
            "residential": best["occ_cls"] == "Residential",
            "single_family": best["prim_occ"] == "Single Family Dwelling",
            "outbldg_flag": bool(best["outbldg"]),
            "segment_length_m": cover_seg["length_m"],
            "match_exact": addr["match_method"] == "exact",
            **_parcel_features(source_id, street_tlids, parcels),
            "pool_m": (parcels or {}).get("pools", {}).get(source_id, np.nan),
        })

    rows.sort(key=lambda r: r["d_m0"])
    rows = rows[:MAX_CANDIDATES]
    # Bigger building closer to the road, nearby: likely this one's garage/barn.
    for r in rows:
        r["bigger_in_front"] = any(
            o is not r and o["sqmeters"] and r["sqmeters"] and o["sqmeters"] > r["sqmeters"]
            and o["dist_road"] < r["dist_road"]
            and haversine_m(r["lat"], r["lon"], o["lat"], o["lon"]) <= OUTBUILDING_RADIUS_M
            for o in rows
        )
    for i, r in enumerate(rows):
        r["d_m0_rank"] = i
    return rows


FEATURES = [
    "d_m0", "d_m0_rank", "on_cover_segment", "same_side", "dt", "rank_gap", "buildings_on_side",
    "implied_addresses", "pos_m", "numbers_from_start", "meters_per_number", "dist_road", "at_end", "nearest_road_is_street", "dist_vs_nearest_road",
    "sqmeters", "residential", "single_family", "outbldg_flag", "bigger_in_front", "segment_length_m",
    "match_exact", "beyond_end",
    "parcel_frontage_this", "parcel_frontage_other", "parcel_frontage_share", "parcel_buildings",
    "parcel_largest", "parcel_area_m2", "parcel_size_ratio", "pool_m",
]


def baseline_picks(candidate_df) -> dict:
    """{method: {address_id: source_id}} for the geometry baselines.
    M1: nearest building to M0 on the address's side (any side if none).
    M2: same-side building on the covering segment whose rank order best
        fits the number's place in the range (M1 if none ranked).
    M3: M2, skipping likely outbuildings (small, or a bigger building in
        front)."""
    picks = {"M1": {}, "M2": {}, "M3": {}}
    for address_id, group in candidate_df.groupby("address_id", sort=False):
        same = group[group["same_side"]]
        m1 = (same if not same.empty else group).sort_values("d_m0").iloc[0]["source_id"]
        picks["M1"][address_id] = m1
        ranked = group.dropna(subset=["rank_gap"])
        picks["M2"][address_id] = ranked.sort_values("rank_gap").iloc[0]["source_id"] if not ranked.empty else m1
        houses = ranked[(ranked["sqmeters"].fillna(0) >= 60) & ~ranked["bigger_in_front"]]
        picks["M3"][address_id] = (
            houses.sort_values("rank_gap").iloc[0]["source_id"] if not houses.empty else picks["M2"][address_id]
        )
    return picks

