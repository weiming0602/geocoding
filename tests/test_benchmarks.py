"""Geocoding accuracy benchmark: scoring + provider response parsing."""

import pytest

from benchmarks.providers import CensusGeocoder, Esri, Google, Nominatim, Result
from benchmarks.run import by_quality, haversine_m, results_row, score
from benchmarks.sample import address_line

SAMPLE = [
    {"id": "a", "true_lat": 43.85, "true_lon": -70.10},
    {"id": "b", "true_lat": 43.85, "true_lon": -70.10},
    {"id": "c", "true_lat": 43.85, "true_lon": -70.10},
    {"id": "d", "true_lat": 43.85, "true_lon": -70.10},
]


def test_haversine_is_meters():
    # 0.001 degree of latitude is ~111 m anywhere.
    assert haversine_m(43.85, -70.10, 43.851, -70.10) == pytest.approx(111.2, abs=0.5)


def test_score_counts_not_found_as_a_miss():
    results = {
        "a": Result(True, 43.85, -70.10),          # exact
        "b": Result(True, 43.8503, -70.10),        # ~33 m
        "c": Result(True, 43.86, -70.10),          # ~1.1 km: wrong place
        "d": Result(False),                         # not found
    }
    rows, s = score(SAMPLE, results)
    assert s["n"] == 4 and s["found"] == 0.75
    assert (s["within_25"], s["within_50"], s["within_150"]) == (0.25, 0.5, 0.5)
    assert s["wrong_place"] == 0.25
    assert s["median_m"] == pytest.approx(33.4, abs=0.5)
    assert rows[3] == {"id": "d", "found": False, "error_m": None, "quality": None}


def test_score_with_nothing_found():
    _, s = score(SAMPLE, {})
    assert s["found"] == 0 and s["median_m"] is None


def test_results_row_formats_a_markdown_table_row():
    class P:
        name, mode = "Meridian", "TIGER only (no E911)"

    _, s = score(SAMPLE[:1], {"a": Result(True, 43.85, -70.10)})
    row = results_row("2026-11-03", "abc123", "maine_e911_300", P, s)
    assert row.startswith("| 2026-11-03 | abc123 | maine_e911_300 | Meridian | TIGER only (no E911) | 100.0% |")
    assert row.count("|") == 13


def test_address_line_has_no_zip():
    assert address_line(440, "TABER HILL ROAD", "VASSALBORO") == "440 Taber Hill Road, Vassalboro, ME"


# --- provider response parsing (recorded shapes, no network) ----------------


def test_census_parse():
    data = {"result": {"addressMatches": [{"coordinates": {"x": -70.11, "y": 43.82}}]}}
    assert CensusGeocoder.parse(data) == Result(True, 43.82, -70.11, "address range")
    assert CensusGeocoder.parse({"result": {"addressMatches": []}}).matched is False


def test_nominatim_parse():
    data = [{"lat": "43.82", "lon": "-70.11", "category": "building", "type": "house"}]
    assert Nominatim.parse(data) == Result(True, 43.82, -70.11, "building/house")
    assert Nominatim.parse([]).matched is False


def test_google_parse():
    data = {"status": "OK", "results": [{"geometry": {"location": {"lat": 43.82, "lng": -70.11}, "location_type": "ROOFTOP"}}]}
    assert Google.parse(data) == Result(True, 43.82, -70.11, "ROOFTOP")
    assert Google.parse({"status": "ZERO_RESULTS", "results": []}) == Result(False, quality="ZERO_RESULTS")


def test_esri_parse():
    data = {"candidates": [{"location": {"x": -70.11, "y": 43.82}, "attributes": {"Addr_type": "PointAddress"}}]}
    assert Esri.parse(data) == Result(True, 43.82, -70.11, "PointAddress")
    assert Esri.parse({"candidates": []}).matched is False


def test_keyed_providers_are_skipped_without_keys(monkeypatch):
    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
    monkeypatch.delenv("ARCGIS_API_KEY", raising=False)
    assert not Google().available() and not Esri().available()
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "x")
    assert Google().available()


def test_by_quality_checks_each_claimed_precision_level():
    results = {
        "a": Result(True, 43.85, -70.10, "ROOFTOP"),
        "b": Result(True, 43.86, -70.10, "ROOFTOP"),  # claims rooftop, ~1.1 km off
        "c": Result(True, 43.8503, -70.10, "RANGE_INTERPOLATED"),
        "d": Result(False),
    }
    rows, _ = score(SAMPLE, results)
    (top, n, within_50, median), (other, n2, within_50_2, _) = by_quality(rows)
    assert (top, n, within_50) == ("ROOFTOP", 2, 0.5)
    assert median == pytest.approx(556, abs=5)
    assert (other, n2, within_50_2) == ("RANGE_INTERPOLATED", 1, 1.0)
