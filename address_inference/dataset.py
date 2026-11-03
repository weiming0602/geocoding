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
"""

SEGMENTS_SQL = """
SELECT sms.label_street, st.tlid, st.lfromadd, st.ltoadd, st.rfromadd, st.rtoadd, st.geometry,
       ST_Length(st.geom::geography)
FROM address_inference.street_match_segments sms
JOIN streets st ON st.tlid = sms.tlid
WHERE sms.region_id = %(region)s AND sms.town = %(town)s
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
"""


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
            if best is None or span < best[3]:
                best = (seg, side, fraction, span)
    return best


def load(dsn, region, town: str):
    params = {"region": region.id, "town": town, "state": region.state_abbr,
              "state_fips": region.state_fips, "radius": TRUE_BUILDING_RADIUS_M}
    with psycopg.connect(dsn) as conn:
        addresses = conn.execute(ADDRESSES_SQL, params).fetchall()
        segments = conn.execute(SEGMENTS_SQL, params).fetchall()
        candidates = conn.execute(CANDIDATES_SQL, params).fetchall()
    return addresses, segments, candidates


def build(addresses, segments, candidates):
    """Returns (address_df, candidate_df). Pure: takes the rows load()
    returns, so it's testable without a database."""
    seg_keys = ("label_street", "tlid", "lfromadd", "ltoadd", "rfromadd", "rtoadd", "geometry", "length_m")
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

    address_rows, cand_rows = [], []
    for site_uid, number, street, method, lat, lon, true_id in addresses:
        street_segs = segs_by_street.get(street, [])
        cover = covering_range(number, street_segs)
        addr = {"id": site_uid, "number": number, "street": street, "match_method": method, "true_lat": lat, "true_lon": lon,
                "true_building": true_id, "scorable": cover is not None}
        if cover is None:
            address_rows.append(addr)
            continue
        seg, side, fraction, span = cover
        m0_lon, m0_lat = interpolate_along_line(seg["points"], fraction, OFFSET_FEET,
                                                "left" if side == "L" else "right")
        addr.update(m0_lat=m0_lat, m0_lon=m0_lon, cover_tlid=seg["tlid"], cover_side=side, f=fraction)
        address_rows.append(addr)
        cand_rows.extend(_candidates_for(addr, seg, side, fraction, span, street_segs, cands_by_street[street]))

    address_df = pd.DataFrame(address_rows)
    candidate_df = pd.DataFrame(cand_rows)
    if not candidate_df.empty:
        candidate_df["label"] = (candidate_df["source_id"] == candidate_df["true_building"]).astype(int)
    return address_df, candidate_df


def _candidates_for(addr, cover_seg, side, fraction, span, street_segs, street_cands):
    range_start = int(cover_seg["lfromadd" if side == "L" else "rfromadd"])
    street_tlids = {s["tlid"] for s in street_segs}
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
        key=lambda c: c["t"],
    )
    rank_frac = {c["source_id"]: (i + 0.5) / len(on_side) for i, c in enumerate(on_side)}
    implied_addresses = span / 2 + 1

    rows = []
    for source_id, cands in by_building.items():
        best = min(cands, key=lambda c: c["dist_m"])  # this building's nearest segment OF THIS STREET
        on_cover = next((c for c in cands if c["tlid"] == cover_seg["tlid"]), None)
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
            "same_side": (on_cover["side"] == side) if on_cover else (best["side"] == side),
            "dt": abs(on_cover["t"] - fraction) * cover_seg["length_m"] if on_cover else np.nan,
            # Raw "how far along" vs "how many numbers along" from the range's
            # start: lets the model learn the local numbering density instead
            # of assuming the range is spread evenly over the segment (M0).
            "pos_m": on_cover["t"] * cover_seg["length_m"] if on_cover else np.nan,
            "numbers_from_start": abs(addr["number"] - range_start),
            "meters_per_number": (on_cover["t"] * cover_seg["length_m"] / abs(addr["number"] - range_start)
                                  if on_cover and addr["number"] != range_start else np.nan),
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
    "match_exact",
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

