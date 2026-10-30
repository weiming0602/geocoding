# Where Meridian's geocoding data comes from

This describes the public data sources behind Meridian's address geocoding,
how that data gets into the system, and how it's actually used to answer a
geocoding request. Current as of August 2026.

## Data sources

### 1. US Census Bureau TIGER/Line — street network

- **What it is:** Shapefiles of every mapped street segment ("edge") in the
  US, published annually by the Census Bureau. Each segment carries its
  geometry plus separate house-number ranges for its left and right sides
  (e.g. odd numbers 1–99 on the left, even numbers 2–98 on the right) and
  ZIP codes for each side.
- **Why it matters:** This is what makes it possible to turn "91 Chestnut
  St, Portland, ME" into a coordinate without a per-address lookup table —
  the house number is interpolated proportionally along the matching
  segment's range (91 out of a 1–99 range sits ~91% of the way along the
  segment), then offset slightly off the centerline onto the correct side
  of the street.
- **License:** Public domain, published by a US federal agency
  (census.gov/geo/tiger).
- **Coverage today:** Maine and New Hampshire. 498,936 street segments and
  475,147 associated street names/aliases currently loaded.
- **Town boundaries** come from the same TIGER/Line release: the
  statewide **county subdivisions** (`COUSUB`) layer -- in New England,
  the real towns and cities (529 in Maine, 259 in New Hampshire, 2024
  vintage) -- loaded into `towns`. TIGER's street segments carry no town
  name, so this is what lets a request find a street inside the town an
  address names even when its ZIP is wrong. Same public-domain license.

### 2. Maine Office of GIS — E911 address points

- **What it is:** ~798,188 real, surveyed per-structure address points for
  Maine (one point per addressable building), published via Maine's public
  ArcGIS FeatureServer (`Maine_E911_Addresses_Feature`).
- **Why it matters:** TIGER's range-interpolation assumes house numbers are
  evenly spaced along a street segment, which is a reasonable approximation
  in dense areas but breaks down on long rural roads with a handful of
  widely-spaced houses — interpolation alone was measured off by ~200 feet
  on a real Brunswick, ME address before this dataset was added. When a
  request matches a real E911 point, Meridian uses that exact point instead
  of falling back to interpolation.
- **License:** Public, maintained by a state government GIS office.
- **Coverage today:** Maine only. No equivalent openly-downloadable dataset
  exists for New Hampshire — that state's E911 address data sits with its
  Dept. of Safety / Emergency Services & Communications and would require a
  direct data-sharing request, not a public download (checked directly;
  not something to assume changes without re-checking).
- **Why this isn't universal:** Real per-structure point data is genuinely
  more accurate than interpolation — it's a surveyed location, not a
  proportional guess along a street's range — but it isn't something every
  state publishes openly. The US DOT maintains a National Address Database
  (NAD) aggregating whatever states/counties choose to contribute; checked
  directly (via DOT's own "NAD County Participation Status" layer), 24
  states plus DC currently have 100% open point coverage, several states
  are partial, and some — including New Hampshire — currently have none in
  the public domain. Maine happens to be one of the fully-covered states,
  independent of the NAD, via its own public E911 GIS feed. This is exactly
  why TIGER range-interpolation is the necessary baseline everywhere (it
  has full US coverage on its own), with real point data layered on top
  only where a state actually makes it available.

### 3. OpenStreetMap — one-way streets (Road Alerts routing only)

- **What it is:** OpenStreetMap's road network, downloaded as Geofabrik's
  daily per-state extracts (`download.geofabrik.de`, ~90 MB for Maine,
  ~70 MB for New Hampshire). Only one thing is taken from it: whether each
  road is one-way (`oneway`, roundabouts, motorways), and in which
  direction.
- **Why it matters:** TIGER has no one-way or direction data at all, so
  Road Alerts' detours used to treat every street as two-way and could
  send a driver the wrong way down a divided highway or ramp (measured:
  ~2 km the wrong way along US Route 1 in Brunswick on a real test trip).
  `geocoding/osm_oneway.py` matches each OSM road onto the TIGER segments
  it overlaps (within 15 m, >= 80% coverage, names agreeing) and records
  the allowed direction in a separate `street_oneway` table, which the
  routing graph reads. As of October 2026: 16,968 Maine/NH segments
  one-way, including ~95% of interstate segments and ~88% of ramps; any
  interstate/ramp segment without a confident match is excluded from
  routing rather than assumed two-way.
- **License:** Open Database License (ODbL) 1.0, © OpenStreetMap
  contributors (openstreetmap.org/copyright). Free for commercial use, with
  conditions:
  - **Attribution** — "© OpenStreetMap contributors" wherever routes built
    with this data are shown (Road Alerts' reroute caveat, the Help pages,
    the sandbox).
  - **Share-alike** — `street_oneway` (OSM directions copied onto TIGER
    segments) is a derivative database. Offering routes built from it to
    the public means offering that derived data under the ODbL on request
    (it's a `tlid -> direction` table; TIGER itself is public domain, so
    this gives away nothing proprietary).
  - **Kept out of geocoding** — the OSM-derived data lives only in
    `osm_ways`/`street_oneway` and is read only by routing
    (`roadReroute.js`, `testDriveRoute.js`). Geocoding (`geocode.js`,
    `reverseGeocode.js`, `interpolate.py`, batch) never touches it, so
    geocoding results stay TIGER + E911 only, free of ODbL terms.
  This is a reading of the ODbL, not legal advice.
- **Coverage today:** Maine and New Hampshire, refreshed by
  `annual_update.py` (or `python -m geocoding.osm_oneway`).

## How the data gets in (and stays current)

| Script | What it does |
| --- | --- |
| `geocoding/ingest.py` | Loads one county's TIGER/Line **edges** shapefile (street geometry + address ranges) into the `streets` table. |
| `geocoding/ingest_featnames.py` | Loads that county's TIGER/Line **featnames** file (street name aliases — many streets go by more than one name) into `street_names`. |
| `geocoding/ingest_address_points.py` | Pages through Maine's public ArcGIS FeatureServer and loads every E911 address point into `address_points`. |
| `geocoding/update_state.py` | Downloads and ingests every county's edges + featnames for one state, for a given TIGER vintage year. |
| `geocoding/ingest_towns.py` | Downloads one state's TIGER/Line **county subdivisions** (town/city boundaries) and upserts them into `towns` by GEOID. |
| `geocoding/annual_update.py` | Runs `update_state` and `ingest_towns` for every covered state plus the Maine address-point refresh, in one command — this is the one meant to run unattended (see `ops/geocoding-annual-update.timer`). |

All of the above are **insert-only and idempotent** — each row is keyed on a
stable ID from the source data itself (TLID for streets/street names,
SITE_UID for address points), so re-running any of them, including on top
of existing data, only adds rows that are genuinely new. (`towns` is the
exception: it's upserted by GEOID instead, since town names and boundaries
do change between vintages -- still safe to re-run.) This is what makes
it safe to run the annual update unattended: it can't corrupt or duplicate
what's already there, whether that's picking up a new TIGER vintage once a
year or newly-added E911 addresses.

## How a geocoding request actually uses this data

For a forward-geocoding request (address → coordinates), Meridian tries, in
order:

1. **Exact E911 point match** (Maine only) — house number + street name +
   town matched directly against a real surveyed point. If found, that
   exact point is returned.
2. **TIGER range interpolation within the named town** — when the address
   names a town, look the street up inside that town's boundary (`towns`),
   ignoring a ZIP that points somewhere else, and interpolate along the
   segment whose range holds the house number. A ZIP that didn't match is
   reported back as `correctedZip`.
3. **TIGER range interpolation by ZIP** — otherwise, look up the street by
   name and ZIP, find the segment whose left or right range contains the
   house number (whichever side's own ZIP and number parity fit — TIGER
   has no fixed odd/even side), interpolate a point proportionally along
   that segment, then offset it slightly off the centerline onto that
   side of the street.

Reverse geocoding (coordinates → address) runs the same logic backwards:
find the nearest street segment, determine which side of it the point falls
on, and interpolate a house number from how far along the segment the point
sits.

Every result reports which path was used (`source: "address_point"` vs.
`"interpolation"`), so accuracy is always visible, not just assumed.
