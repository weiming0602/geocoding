"""Stage 1 of address_inference: region config + footprint loading."""

import json
from datetime import date

import psycopg
import pytest

from address_inference.load_footprints import build_where, load_footprints
from address_inference.regions import load_region, parse_region
from address_inference.sources.usa_structures import normalize_feature
from geocoding.schema import CREATE_TOWNS_TABLE_SQL

SQUARE = {
    "type": "Polygon",
    "coordinates": [[[-70.10, 43.85], [-70.10, 43.8501], [-70.0999, 43.8501], [-70.0999, 43.85], [-70.10, 43.85]]],
}


def feature(uuid, occ="Residential", sqm=120.0, geometry=SQUARE, **extra):
    props = {
        "UUID": "{" + uuid.upper() + "}",
        "BUILD_ID": 1,
        "STATE_FIPS": "23",
        "FIPS": "23005",
        "OCC_CLS": occ,
        "PRIM_OCC": "Single Family Dwelling",
        "OUTBLDG": None,
        "SQMETERS": sqm,
        "VAL_METHOD": "Automated",
        "IMAGE_DATE": 1759968000000,  # 2025-10-09 UTC
        "PROD_DATE": None,
        **extra,
    }
    return {"type": "Feature", "geometry": geometry, "properties": props}


class FakeSource:
    def __init__(self, features):
        self.features = features
        self.calls = []

    def object_ids(self, where, envelope=None):
        self.calls.append((where, envelope))
        return list(range(len(self.features)))

    def fetch(self, object_ids):
        yield [row for row in (normalize_feature(self.features[i]) for i in object_ids) if row]


ME = parse_region(
    {"id": "me", "name": "Maine", "state_fips": "23", "state_abbr": "ME", "footprints": {"source": "usa_structures"}}
)


# --- region config ---------------------------------------------------------


def test_maine_region_config_loads():
    region = load_region("me")
    assert (region.state_fips, region.state_abbr, region.footprint_source) == ("23", "ME", "usa_structures")
    assert region.label_sources == ("maine_e911",)


@pytest.mark.parametrize(
    "change, message",
    [
        ({"state_fips": "2"}, "state_fips"),
        ({"state_abbr": "me"}, "state_abbr"),
        ({"footprints": {"source": "nope"}}, "footprint source"),
        ({"labels": [{"source": "nope"}]}, "label source"),
    ],
)
def test_region_config_rejects_bad_values(change, message):
    data = {"id": "x", "name": "X", "state_fips": "23", "state_abbr": "ME", "footprints": {"source": "usa_structures"}}
    with pytest.raises(ValueError, match=message):
        parse_region({**data, **change})


def test_unknown_region_names_the_available_ones():
    with pytest.raises(ValueError, match="available: me"):
        load_region("zz")


# --- adapter ---------------------------------------------------------------


def test_normalize_feature_drops_parcel_address_fields():
    row = normalize_feature(feature("abc-1", PROP_ADDR="25 Maine St", PROP_ZIP="04011", PROP_CITY="Brunswick"))
    assert row["source_id"] == "abc-1"  # braces stripped, lowercased
    assert row["image_date"] == date(2025, 10, 9)
    assert "25 Maine St" not in json.dumps(row, default=str)
    assert not any(key.lower().startswith("prop") for key in row)


def test_normalize_feature_skips_unusable_features():
    assert normalize_feature(feature("abc-1", geometry=None)) is None
    assert normalize_feature(feature("abc-1", geometry={"type": "Point", "coordinates": [0, 0]})) is None
    no_id = feature("x")
    no_id["properties"].update(UUID=None, BUILD_ID=None)
    assert normalize_feature(no_id) is None


def test_build_where_validates_county():
    assert build_where("23", None) == "STATE_FIPS='23'"
    assert build_where("23", "23005") == "STATE_FIPS='23' AND FIPS='23005'"
    with pytest.raises(ValueError):
        build_where("23", "33005")  # another state's county
    with pytest.raises(ValueError):
        build_where("23", "23005' OR '1'='1")


# --- loading into Postgres -------------------------------------------------


def test_load_writes_rows_into_the_state_partition(dsn):
    source = FakeSource([feature("a-1", PROP_ADDR="1 Main St"), feature("a-2", occ="Commercial", sqm=900.0)])
    assert load_footprints(dsn, ME, source=source, progress=lambda _: None) == 2

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            """SELECT source_id, occ_cls, county_fips, ST_GeometryType(geom), ST_Within(inner_point, geom)
               FROM address_inference.structures_23 ORDER BY source_id"""
        ).fetchall()
        columns = [r[0] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='address_inference' AND table_name='structures'"
        )]
    assert rows == [
        ("a-1", "Residential", "23005", "ST_MultiPolygon", True),
        ("a-2", "Commercial", "23005", "ST_MultiPolygon", True),
    ]
    assert not any(c.startswith("prop") for c in columns)
    assert source.calls == [("STATE_FIPS='23'", None)]


def test_reload_updates_in_place_instead_of_duplicating(dsn):
    load_footprints(dsn, ME, source=FakeSource([feature("a-1", sqm=100.0)]), progress=lambda _: None)
    load_footprints(dsn, ME, source=FakeSource([feature("a-1", sqm=150.0)]), progress=lambda _: None)
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SELECT count(*), max(sqmeters) FROM address_inference.structures").fetchone() == (1, 150.0)


def test_town_option_queries_the_towns_bounding_box(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute(CREATE_TOWNS_TABLE_SQL)
        conn.execute(
            """INSERT INTO towns (geoid, state_abbr, name, geom) VALUES
               ('1', 'ME', 'Freeport', ST_Multi(ST_MakeEnvelope(-70.2, 43.8, -70.0, 43.9, 4326)))"""
        )
    source = FakeSource([feature("a-1")])
    load_footprints(dsn, ME, town="freeport", source=source, progress=lambda _: None)
    where, envelope = source.calls[0]
    assert where == "STATE_FIPS='23'"
    assert tuple(round(v, 6) for v in envelope) == (-70.2, 43.8, -70.0, 43.9)

    with pytest.raises(ValueError, match="not found"):
        load_footprints(dsn, ME, town="Atlantis", source=FakeSource([]), progress=lambda _: None)
