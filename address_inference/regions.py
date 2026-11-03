"""Region config: one TOML file per region in address_inference/regions/."""

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

REGIONS_DIR = Path(__file__).parent / "regions"

KNOWN_FOOTPRINT_SOURCES = {"usa_structures"}
KNOWN_LABEL_SOURCES = {"maine_e911"}


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    state_fips: str
    state_abbr: str
    footprint_source: str
    label_sources: tuple = field(default_factory=tuple)


def parse_region(data: dict) -> Region:
    """Validates one region's parsed TOML. Raises ValueError on anything a
    later stage would trip over, so a bad config fails before any download."""
    for key in ("id", "name", "state_fips", "state_abbr", "footprints"):
        if key not in data:
            raise ValueError(f"region config is missing '{key}'")
    if not re.fullmatch(r"\d{2}", data["state_fips"]):
        raise ValueError(f"state_fips must be two digits, got {data['state_fips']!r}")
    if not re.fullmatch(r"[A-Z]{2}", data["state_abbr"]):
        raise ValueError(f"state_abbr must be two capital letters, got {data['state_abbr']!r}")

    footprint_source = data["footprints"].get("source")
    if footprint_source not in KNOWN_FOOTPRINT_SOURCES:
        raise ValueError(f"unknown footprint source {footprint_source!r}")

    label_sources = tuple(entry.get("source") for entry in data.get("labels", []))
    for source in label_sources:
        if source not in KNOWN_LABEL_SOURCES:
            raise ValueError(f"unknown label source {source!r}")

    return Region(
        id=data["id"],
        name=data["name"],
        state_fips=data["state_fips"],
        state_abbr=data["state_abbr"],
        footprint_source=footprint_source,
        label_sources=label_sources,
    )


def load_region(region_id: str, regions_dir: Path = REGIONS_DIR) -> Region:
    path = regions_dir / f"{region_id}.toml"
    if not path.exists():
        available = sorted(p.stem for p in regions_dir.glob("*.toml"))
        raise ValueError(f"no region config {path.name} (available: {', '.join(available)})")
    with path.open("rb") as f:
        region = parse_region(tomllib.load(f))
    if region.id != region_id:
        raise ValueError(f"{path.name} declares id {region.id!r}, expected {region_id!r}")
    return region
