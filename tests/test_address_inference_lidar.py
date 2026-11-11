"""address_inference.lidar: roofs from lidar returns, on synthetic points."""

import numpy as np

from address_inference import lidar


def points(n=60, seed=0):
    """A 60 x 60 m flat field (ground at z=10, 6 points/m2) with a 10 x 12 m
    roof 6 m up at (10..20, 10..22) and a 10 x 10 m tree at (35..45, 35..45)
    whose leaves stop some pulses but let others reach the ground."""
    rng = np.random.default_rng(seed)
    xy = rng.uniform(0, n, size=(6 * n * n, 2))
    x, y = xy[:, 0], xy[:, 1]
    z = np.full(len(x), 10.0)
    cls = np.full(len(x), 2.0)
    roof = (x >= 10) & (x < 20) & (y >= 10) & (y < 22)
    z[roof], cls[roof] = 16.0, 1.0
    tree = (x >= 35) & (x < 45) & (y >= 35) & (y < 45)
    leaves = tree & (rng.uniform(size=len(x)) < 0.5)
    z[leaves], cls[leaves] = 18.0, 1.0
    ones = np.ones(len(x))
    return np.column_stack([x, y, z, cls, ones, ones])


def test_a_roof_stops_every_pulse_and_a_tree_does_not():
    roof, height = lidar.roof_grid(points(), 1.0, 0, 60, 60, 60)
    # rows count down from y=60: the roof's y 10..22 is rows 38..50
    assert 100 <= roof[38:50, 10:20].sum() <= 120
    assert roof[15:25, 35:45].sum() == 0    # tree: ground shows through
    assert roof.sum() <= 125                # nothing else
    assert np.nanmedian(height[roof]) == np.float64(6.0)


def test_a_building_takes_the_whole_roof_its_outline_touches(monkeypatch, tmp_path):
    monkeypatch.setattr(lidar, "ROOT", tmp_path)
    # The outline covers only the roof's western 3 m (trees hid the rest).
    monkeypatch.setattr(lidar, "read_points", lambda project, *box: points())
    monkeypatch.setattr(lidar, "TILE_M", 60.0)
    monkeypatch.setattr(lidar, "PAD_M", 0.0)
    strip = '{"type": "Polygon", "coordinates": [[[10, 10], [13, 10], [13, 22], [10, 22], [10, 10]]]}'
    # lat 0 -> no Mercator scaling; tile (0, 0) spans 0..60 m
    [(sid, m2, h)] = lidar.measure_tile(((0, 0), 1.0, [("b", 0.0, 0.0, strip)]))
    assert sid == "b" and 100 <= m2 <= 125 and h == 6.0
