"""Isolated buildings (owner, 2026-11-16): a building far from every other building is somebody's home, so
- LONER_STREET: it belongs to the street its access reaches -- the imagery-traced driveway's road, else the road
  its OSM trail reaches (252 Bayview Road), else its nearest road -- and a number on another street can't take
  it (31 Chart House Road took 11 Bristol Way's house; 672 Harpswell Neck Road took 20 Lot Five Road's).
- LONER_ONE: it takes one number. Two numbers on one loner (22 Harpswell Harbor Drive and 183 Harpswell Neck
  Road): the one on its access street, else the stronger ranker score, keeps it; the other takes its next
  best building.
Both act in road order, after the ranker scores -- no retraining, so nothing elsewhere moves.
Isolated = no other building within LONER_M (order.load_isolation's nearest-other distance).
"""
from collections import defaultdict

import psycopg

from .street_names import canonical

LONER_STREET = False
LONER_ONE = False
LONER_M = 60.0
TRAIL_MIN_PATH_M = 40  # dataset.TRAIL_MIN_PATH_M: a real walk on paths, not a house beside a drive


def load_access(dsn, loners) -> dict:
    """{source_id: canonical road} for loners with a traced driveway (cheapest road) or a trail walk."""
    out = {}
    ids = list(loners)
    with psycopg.connect(dsn) as conn:
        if not conn.execute("SELECT to_regclass('address_inference.building_driveways') IS NULL").fetchone()[0]:
            for sid, road in conn.execute(
                    "SELECT DISTINCT ON (source_id) source_id, road FROM address_inference.building_driveways "
                    "WHERE source_id = ANY(%s) ORDER BY source_id, cost", (ids,)):
                out[sid] = road
        if not conn.execute("SELECT to_regclass('address_inference.building_trails') IS NULL").fetchone()[0]:
            for sid, road in conn.execute(
                    "SELECT DISTINCT ON (source_id) source_id, road FROM address_inference.building_trails "
                    "WHERE source_id = ANY(%s) AND source_id IN (SELECT source_id FROM address_inference.building_trails "
                    "WHERE path_m >= %s) ORDER BY source_id, walk_m", (ids, TRAIL_MIN_PATH_M)):
                out.setdefault(sid, road)
    return out


def access_streets(scored, address_df, loners, access) -> dict:
    """{source_id: set of address street labels} each loner belongs to (only where that's decidable)."""
    street_of = dict(zip(address_df["id"], address_df["street"]))
    rows = scored[scored["source_id"].isin(loners)]
    cand = defaultdict(set)
    nearest = defaultdict(set)
    for aid, sid, dvn in zip(rows["address_id"], rows["source_id"], rows["dist_vs_nearest_road"]):
        st = street_of.get(aid)
        if st is None:
            continue
        cand[sid].add(st)
        if dvn == dvn and dvn < 1:  # this street is the building's nearest road
            nearest[sid].add(st)
    out = {}
    for sid, streets in cand.items():
        road = access.get(sid)
        if road is not None:
            mine = {st for st in streets if canonical(st) == road}
            if mine:
                out[sid] = mine
                continue
            if road:  # its access reaches a road it isn't a candidate for: no say
                continue
        if nearest[sid] and len(streets) > 1:
            out[sid] = nearest[sid]
    return out


def street_filter(scored, address_df, owner_streets):
    """scored without loner rows on streets the loner doesn't belong to."""
    if not owner_streets:
        return scored
    street_of = dict(zip(address_df["id"], address_df["street"]))
    keep = [not (sid in owner_streets and street_of.get(aid) not in owner_streets[sid])
            for aid, sid in zip(scored["address_id"], scored["source_id"])]
    return scored[keep]


def one_number(picks, scored, address_df, loners, owner_streets) -> dict:
    """picks where no loner holds two street numbers (all E911 points of one number count as one)."""
    info = address_df.set_index("id")[["street", "number"]]
    score = {(a, s): v for a, s, v in zip(scored["address_id"], scored["source_id"], scored["score"])}
    holders = defaultdict(lambda: defaultdict(list))  # loner -> (street, number) -> address ids
    for aid, sid in picks.items():
        if sid in loners and aid in info.index:
            holders[sid][(info.at[aid, "street"], int(info.at[aid, "number"]))].append(aid)
    out = dict(picks)
    taken = set(picks.values())
    by_address = defaultdict(list)
    for a, s, v in zip(scored["address_id"], scored["source_id"], scored["score"]):
        by_address[a].append((v, s))
    for sid, nums in holders.items():
        if len(nums) < 2:
            continue
        mine = owner_streets.get(sid, set())
        keeper = max(nums, key=lambda k: (k[0] in mine, max(score.get((a, sid), -1e9) for a in nums[k])))
        for k, aids in nums.items():
            if k == keeper:
                continue
            for aid in aids:
                nxt = [s for v, s in sorted(by_address[aid], reverse=True) if s != sid and s not in taken]
                if nxt:
                    out[aid] = nxt[0]
                else:
                    out.pop(aid, None)
            if nxt:
                taken.add(nxt[0])
    return out
