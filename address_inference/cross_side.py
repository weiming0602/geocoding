"""Numbers the addresser put across the road (owner, 2026-11-16, 120 Allen Point Road, Harpswell: an even
number on the odd side -- both TIGER's and E911's own ranges have evens on the other side).

A number with no building on its own side near its road-start spot (rate_spots' d_rate_len > CROSS_OWN_MIN_M)
but a building on the opposite side right at it (d_rate_len <= CROSS_MAX_M, and the closest of all its
candidates) takes that building, and no other number may take it. Without this, 120 couldn't take its house
(wrong side for its parity), the house stayed free on the odd side and 89 took it instead of its own.
Acts on the ranker's scores before road order -- no retraining. Public data only.
"""
import numpy as np

CROSS_SIDE = False
CROSS_OWN_MIN_M = 60.0
CROSS_MAX_M = 25.0


def anchors(scored, address_df) -> dict:
    """{address_id: source_id} of numbers the addresser put across the road."""
    if "d_rate_len" not in scored.columns:
        return {}
    out = {}
    for aid, g in scored.groupby("address_id"):
        d = g["d_rate_len"]
        if d.isna().all():
            continue
        same = g["same_side"].astype(bool)
        own = d[same].min() if same.any() else np.inf
        other = g[~same & d.notna()]
        if not len(other) or not (own > CROSS_OWN_MIN_M):
            continue
        best = other.loc[other["d_rate_len"].idxmin()]
        if best["d_rate_len"] <= CROSS_MAX_M and best["d_rate_len"] <= d.min():
            out[aid] = best["source_id"]
    # a building wanted by two such numbers is no clear case: drop both
    counts = {}
    for b in out.values():
        counts[b] = counts.get(b, 0) + 1
    return {a: b for a, b in out.items() if counts[b] == 1}


def apply(scored, address_df):
    """scored where each across-the-road number keeps only its building (counted as its own side), and no
    other number can take that building. Returns (scored, anchors)."""
    if not CROSS_SIDE:
        return scored, {}
    found = anchors(scored, address_df)
    if not found:
        return scored, found
    taken = set(found.values())
    pair = list(zip(scored["address_id"], scored["source_id"]))
    keep = np.array([(b == found[a]) if a in found else (b not in taken) for a, b in pair], dtype=bool)
    out = scored[keep].copy()
    mask = out["address_id"].isin(found)
    out.loc[mask, "same_side"] = True
    return out, found
