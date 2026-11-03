"""Geocoders the benchmark can score. Each returns, per address id, a
Result: whether it found the address, where, and the service's own label
for how precise it claims to be.

A provider whose API key isn't set is skipped (`available()` is False),
so Google/Esri join the runs as soon as their keys exist:
    GOOGLE_MAPS_API_KEY   Google Geocoding API (billed per request)
    ARCGIS_API_KEY        Esri ArcGIS geocoding service

Third-party coordinates are never written anywhere (Google's terms limit
caching them); only the error in meters is kept. See benchmarks/run.py.
"""

import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
USER_AGENT = "MeridianGeocodingBenchmark/1.0 (+https://www.meridiangeocoding.com)"


@dataclass
class Result:
    matched: bool
    lat: float | None = None
    lon: float | None = None
    quality: str | None = None  # the service's own match-type label


def _get_json(url: str, timeout: float = 30) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.load(response)
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


class Provider:
    name = ""
    mode = ""  # what variant of the service this is, for the results table
    pause_seconds = 0.0

    def available(self) -> bool:
        return True

    def geocode_one(self, address: str) -> Result:
        raise NotImplementedError

    def geocode_all(self, addresses, progress=lambda done, total: None) -> dict:
        """{id: Result} for [{"id", "address"}, ...]. One failed request
        counts as not found, not as a crashed run."""
        results = {}
        for i, row in enumerate(addresses, 1):
            try:
                results[row["id"]] = self.geocode_one(row["address"])
            except Exception as err:  # noqa: BLE001 -- recorded, never fatal
                results[row["id"]] = Result(False, quality=f"request failed: {type(err).__name__}")
            progress(i, len(addresses))
            if self.pause_seconds:
                time.sleep(self.pause_seconds)
        return results


class Meridian(Provider):
    """Meridian's own geocode(), run via geocoding-server/scripts/
    benchmark-geocode.js straight against the local database."""

    name = "Meridian"

    def __init__(self, tiger_only: bool):
        self.tiger_only = tiger_only
        self.mode = "TIGER only (no E911)" if tiger_only else "as shipped (E911 + TIGER)"

    def geocode_all(self, addresses, progress=lambda done, total: None) -> dict:
        args = ["node", "scripts/benchmark-geocode.js"] + (["--tiger-only"] if self.tiger_only else [])
        stdin = "".join(json.dumps({"id": r["id"], "address": r["address"]}) + "\n" for r in addresses)
        proc = subprocess.run(
            args, input=stdin, capture_output=True, text=True, cwd=REPO / "geocoding-server", check=True
        )
        results = {}
        for line in proc.stdout.splitlines():
            out = json.loads(line)
            results[out["id"]] = Result(out["matched"], out["latitude"], out["longitude"], out["source"])
        progress(len(addresses), len(addresses))
        return results


class CensusGeocoder(Provider):
    """US Census Bureau geocoder: free, public domain, and built on TIGER
    address ranges like Meridian's interpolation -- the closest peer."""

    name = "US Census Geocoder"
    mode = "Public_AR_Current"
    pause_seconds = 0.2
    URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

    def geocode_one(self, address: str) -> Result:
        query = urllib.parse.urlencode({"address": address, "benchmark": "Public_AR_Current", "format": "json"})
        return self.parse(_get_json(f"{self.URL}?{query}"))

    @staticmethod
    def parse(data: dict) -> Result:
        matches = (data.get("result") or {}).get("addressMatches") or []
        if not matches:
            return Result(False)
        coords = matches[0]["coordinates"]
        return Result(True, coords["y"], coords["x"], "address range")


class Nominatim(Provider):
    """OpenStreetMap's public geocoder. Its usage policy allows at most 1
    request/second with an identifying User-Agent."""

    name = "Nominatim (OpenStreetMap)"
    mode = "public API"
    pause_seconds = 1.1
    URL = "https://nominatim.openstreetmap.org/search"

    def geocode_one(self, address: str) -> Result:
        query = urllib.parse.urlencode({"q": address, "format": "jsonv2", "limit": 1, "countrycodes": "us"})
        return self.parse(_get_json(f"{self.URL}?{query}"))

    @staticmethod
    def parse(data) -> Result:
        if not data:
            return Result(False)
        top = data[0]
        return Result(True, float(top["lat"]), float(top["lon"]), f"{top.get('category')}/{top.get('type')}")


class Google(Provider):
    name = "Google Geocoding API"
    mode = "geocode/json"
    pause_seconds = 0.05
    URL = "https://maps.googleapis.com/maps/api/geocode/json"

    def available(self) -> bool:
        return bool(os.environ.get("GOOGLE_MAPS_API_KEY"))

    def geocode_one(self, address: str) -> Result:
        query = urllib.parse.urlencode({"address": address, "key": os.environ["GOOGLE_MAPS_API_KEY"]})
        return self.parse(_get_json(f"{self.URL}?{query}"))

    @staticmethod
    def parse(data: dict) -> Result:
        if data.get("status") != "OK" or not data.get("results"):
            return Result(False, quality=data.get("status"))
        top = data["results"][0]["geometry"]
        return Result(True, top["location"]["lat"], top["location"]["lng"], top.get("location_type"))


class Esri(Provider):
    name = "Esri ArcGIS geocoding"
    mode = "findAddressCandidates"
    pause_seconds = 0.05
    URL = "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates"

    def available(self) -> bool:
        return bool(os.environ.get("ARCGIS_API_KEY"))

    def geocode_one(self, address: str) -> Result:
        query = urllib.parse.urlencode({
            "SingleLine": address, "f": "json", "maxLocations": 1, "outFields": "Addr_type,Score",
            "token": os.environ["ARCGIS_API_KEY"],
        })
        return self.parse(_get_json(f"{self.URL}?{query}"))

    @staticmethod
    def parse(data: dict) -> Result:
        candidates = data.get("candidates") or []
        if not candidates:
            return Result(False)
        top = candidates[0]
        return Result(True, top["location"]["y"], top["location"]["x"], (top.get("attributes") or {}).get("Addr_type"))


def all_providers():
    return [Meridian(tiger_only=False), Meridian(tiger_only=True), CensusGeocoder(), Nominatim(), Google(), Esri()]
