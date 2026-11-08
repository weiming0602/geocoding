"""address_inference.driveways: cheapest path over pavement, on a synthetic image."""

import json
import math

import numpy as np
import pytest

from address_inference import dataset, driveways, imagery

LAT, LON = 43.85, -70.10


def offset(east_m, north_m):
    """(lon, lat) east_m / north_m meters from the house."""
    return (LON + east_m / (111320 * math.cos(math.radians(LAT))), LAT + north_m / 111320)


def fake_bands(monkeypatch, paved_path):
    """Grass everywhere (red 40, NIR 150) except `paved_path` ((east, north) meter
    points, a 6 m wide strip between consecutive points): pavement (red 150, NIR 140)."""
    bbox = imagery.bbox_around(LAT, LON, driveways.HALF_M)
    size = driveways.SIZE
    x0, y0, x1, y1 = bbox
    red = np.full((size, size), 40.0, dtype=np.float32)
    nir = np.full((size, size), 150.0, dtype=np.float32)
    to_px = lambda lo, la: ((imagery.merc(lo, la)[0] - x0) / (x1 - x0) * size, (y1 - imagery.merc(lo, la)[1]) / (y1 - y0) * size)
    for (e0, n0), (e1, n1) in zip(paved_path, paved_path[1:]):
        for t in np.linspace(0, 1, 400):
            px, py = to_px(*offset(e0 + (e1 - e0) * t, n0 + (n1 - n0) * t))
            r0, c0 = int(py), int(px)
            red[max(0, r0 - 4):r0 + 5, max(0, c0 - 4):c0 + 5] = 150
            nir[max(0, r0 - 4):r0 + 5, max(0, c0 - 4):c0 + 5] = 140
    # isolated dark-but-bright specks in the grass must not become shortcuts
    red[10, 10] = 150
    nir[10, 10] = 140
    monkeypatch.setattr(imagery, "crop", lambda b, s, band: (red if band == 0 else nir).copy())


def square(half_m):
    pts = [offset(-half_m, -half_m), offset(half_m, -half_m), offset(half_m, half_m), offset(-half_m, half_m)]
    return json.dumps({"type": "Polygon", "coordinates": [pts + [pts[0]]]})


def line(*points_m):
    return json.dumps({"type": "LineString", "coordinates": [list(offset(e, n)) for e, n in points_m]})


def test_the_driveway_reaches_the_farther_road(monkeypatch):
    # Road A runs 60 m east of the house across grass; road B runs 150 m
    # south, and a paved driveway leads straight down to it.
    fake_bands(monkeypatch, [(0, 0), (0, -150)])
    roads = {0: [("Ash Rd", line((60, -200), (60, 200))), ("Birch Rd", line((-200, -150), (200, -150)))]}
    costs = driveways.road_costs(LAT, LON, square(6), roads)[0]
    assert costs["BIRCH RD"] < costs["ASH RD"]


def test_without_a_driveway_the_nearer_road_wins(monkeypatch):
    fake_bands(monkeypatch, [(0, 0), (0, 0)])
    roads = {0: [("Ash Rd", line((60, -200), (60, 200))), ("Birch Rd", line((-200, -150), (200, -150)))]}
    costs = driveways.road_costs(LAT, LON, square(6), roads)[0]
    assert costs["ASH RD"] < costs["BIRCH RD"]


def test_driveway_features_compare_this_street_with_the_easiest_road():
    parcels = {"driveways": {"b": {"ASH RD": 900.0, "BIRCH RD": 300.0}},
               "driveway_off": {"b": {"ASH RD": 250.0, "BIRCH RD": 2.0}}}
    assert dataset._driveway_features("b", {"BIRCH RD"}, parcels) == {
        "drive_ratio": 1.0, "drive_best": 1.0, "drive_off_m": 2.0}
    f = dataset._driveway_features("b", {"ASH RD"}, parcels)
    assert f["drive_ratio"] == pytest.approx(3.0) and f["drive_best"] == 0.0
    assert all(np.isnan(v) for v in dataset._driveway_features("b", {"ELM ST"}, parcels).values())
    assert all(np.isnan(v) for v in dataset._driveway_features("near_the_road", {"ASH RD"}, parcels).values())


def test_a_road_branching_off_the_driveways_road_is_not_reached_by_the_driveway(monkeypatch):
    # The driveway runs 150 m south to Birch Rd; Cedar Ln branches off Birch
    # Rd 40 m east of where the driveway meets it and runs south. Getting to
    # Cedar Ln means going along Birch Rd first -- the driveway is Birch's.
    monkeypatch.setattr(driveways, "BRANCH_CHECK", True)
    fake_bands(monkeypatch, [(0, 0), (0, -150)])
    roads = {0: [("Birch Rd", line((-200, -150), (200, -150))), ("Cedar Ln", line((40, -150), (40, -260)))]}
    costs = driveways.road_costs(LAT, LON, square(6), roads)[0]
    assert costs.get("CEDAR LN", float("inf")) > 1.5 * costs["BIRCH RD"]


def test_a_building_with_one_road_in_reach_skips_the_imagery(monkeypatch):
    monkeypatch.setattr(imagery, "crop", lambda *a: (_ for _ in ()).throw(AssertionError("imagery read")))
    roads = {0: [("Ash Rd", line((60, -200), (60, 200)))], 1: [("Ash Road", line((60, -200), (60, 200)))]}
    assert driveways.road_costs(LAT, LON, square(6), roads) == {0: {"ASH RD": 1.0}, 1: {"ASH RD": 1.0}}


def test_the_entry_is_where_the_driveway_meets_the_road(monkeypatch):
    # The driveway runs south, then east along a lane, reaching Birch Rd
    # 80 m east of the house: that's its entry, not the point straight south.
    fake_bands(monkeypatch, [(0, 0), (0, -100), (80, -100), (80, -150)])
    roads = {0: [("Birch Rd", line((-200, -150), (200, -150))), ("Ash Rd", line((-200, 200), (200, 200)))]}
    paths = driveways.road_paths(LAT, LON, square(6), roads)[0]
    _cost, la, lo, off = paths["BIRCH RD"]
    east, north = (lo - LON) * 111320 * math.cos(math.radians(LAT)), (la - LAT) * 111320
    # Reached at the road's edge (VIA_BUFFER_PX, ~6 m), not its centerline.
    assert east == pytest.approx(80, abs=6) and north == pytest.approx(-150, abs=8)
    assert off < 5                   # all on the driveway
    assert paths["ASH RD"][3] > 150  # across grass to Ash Rd
