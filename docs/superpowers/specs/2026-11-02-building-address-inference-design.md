# Building-Based Address Inference Design (Freeport first, region-scalable)

## Context

Meridian places an address in one of two ways (`geocode.js`):

1. **Maine E911 address point**: a real, surveyed point per structure
   (`address_points`, ~798K rows). Exact, but **Maine only**. New Hampshire
   publishes no equivalent (see `DATA_SOURCES.md` §2), and neither do many
   other states.
2. **TIGER range interpolation**: a proportional guess along the street
   segment, offset 20 ft to one side. Available everywhere, but it assumes
   evenly spaced house numbers, which is badly wrong on rural roads (~200 ft
   off on a measured Brunswick address).

Everywhere outside Maine, Meridian only has option 2. This experiment
asks whether **building footprints** (public, nationwide, already derived
from aerial imagery by FEMA/ORNL) combined with TIGER ranges can produce
E911-like, per-building locations where no E911 data exists.

Maine's E911 points are the answer key. Freeport has 5,300 of them on 493
streets: a mix of a dense village (Main St / US-1), suburban streets, and
long rural roads. It's small enough to iterate on in minutes, and varied
enough that one accuracy number isn't hiding a single easy street type.

## Question

> For a Freeport address, how much closer to the true (E911) location does a
> footprint-based prediction land than today's TIGER interpolation?
> And how often does it pick the right building?

## Goals

- A reproducible pipeline: load footprints for Freeport, predict a location
  for every E911 address **without looking at E911**, then score the
  predictions against E911.
- Score against today's interpolation as the baseline, so every method is
  judged by how much it improves on what Meridian already does.
- Results broken down by street type (village / suburban / rural), so we
  know *where* it works, not just whether it works.
- A clear decision at the end: continue (generalize to NH), refine, or drop.

## Non-goals

- **No production changes.** Nothing in `geocoding-server`, no change to
  `geocode.js` / `interpolate.py` / `schema.py`. Experiment tables live in
  their own Postgres schema (`address_inference`), which the server never reads.
- **No LLM in the core loop.** The learning part is a supervised model
  trained on E911 labels (see "Machine learning" below). LLMs/vision
  models only enter as extra *features* in Phase 4, never as the decider.
- **No imagery processing in Phase 1.** We use footprints that others have
  already extracted from imagery, rather than extracting them again.
- **Not NH yet.** NH is the point of this work, but it has no answer key,
  so it's scored only after Maine shows the method is worth it.

## Data sources

| Data | Use | License | Status |
|---|---|---|---|
| TIGER `streets` (already loaded) | Segments, address ranges, ZIPs | Public domain | In DB |
| Maine E911 `address_points` (already loaded) | **Answer key only.** Never an input to prediction. | Public (Maine GIS) | In DB |
| **FEMA/ORNL USA Structures** | Building footprint polygons + occupancy class + area | **CC BY 4.0** (attribution required; see `DATA_SOURCES.md` §4) | Freeport loaded |
| Maine GeoLibrary structures layer | Fallback/comparison footprint source | Public (verify terms) | Optional |

**Leakage rule:** USA Structures also carries parcel-derived address fields
(`PROP_ADDR`, `PROP_CITY`, `PROP_ZIP`). These are **dropped at ingest**:
they'd let the prediction "see" the answer, and their redistribution terms
are unclear. They may be measured separately later as a different data
source, never mixed into the geometry methods.

Fields kept: footprint polygon, `OCC_CLS` (e.g. Residential, Commercial),
`PRIM_OCC` (e.g. Single Family Dwelling, Manufactured Home), `SQMETERS`,
source ID.

## Architecture

```
            ┌────────────────────┐
            │ USA Structures     │  ArcGIS FeatureServer, bbox = Freeport
            │ (FEMA/ORNL)        │  (same paginated pattern as
            └─────────┬──────────┘   ingest_address_points.py)
                      │ 1. ingest (drop PROP_* fields)
                      ▼
 ┌──────────┐   ┌──────────────────────┐   ┌───────────────────┐
 │ streets  │──▶│ address_inference.       │◀──│ towns (Freeport   │
 │ (TIGER)  │   │   structures         │   │  boundary clip)   │
 └────┬─────┘   └─────────┬────────────┘   └───────────────────┘
      │                   │ 2. attach each building to a street segment + side
      │                   ▼
      │         ┌──────────────────────┐
      └────────▶│ address_inference.       │  building_id, tlid, side (L/R),
                │   building_segment   │  position along segment (0..1),
                └─────────┬────────────┘  distance to centerline
                          │ 3. predict (one table per method)
                          ▼
                ┌──────────────────────┐
                │ address_inference.       │  method, address (number + street
                │   predictions        │  + ZIP), predicted point, building_id
                └─────────┬────────────┘
                          │ 4. score against the answer key
   ┌──────────────┐       ▼
   │ address_     │──▶ address_inference.scores ──▶ report (markdown + map layers
   │ points (E911)│                              for QGIS)
   └──────────────┘
```

### Stage 1: Ingest footprints

**Built** (`address_inference/load_footprints.py` +
`sources/usa_structures.py`, tests in
`tests/test_address_inference_footprints.py`):

```
python -m address_inference.load_footprints "dbname=geocoding" me --town Freeport
python -m address_inference.load_footprints "dbname=geocoding" me --county 23005
python -m address_inference.load_footprints "dbname=geocoding" me
```

- Esri's hosted USA Structures layer **rejects offset paging**
  (`resultOffset`/`resultRecordCount` → "Invalid query parameters"), so
  it pages by object ID: one `returnIdsOnly` query, then 500 IDs per
  request, as GeoJSON so the server builds valid polygons.
- Upserts by (state, source, source id), into a per-state partition
  (`address_inference.structures_23`). Re-running refreshes in place.
- Stored: polygon, `inner_point` (`ST_PointOnSurface`, always inside the
  footprint), `occ_cls`, `prim_occ`, `outbldg` (the source's own
  outbuilding flag, a free garage/shed signal for M3), `sqmeters`,
  `val_method`, imagery and production dates. `PROP_*` dropped.

**First measurements (Freeport, 2026-11-02):**

| | |
|---|---|
| Structures in Freeport's bbox / inside the town | 7,441 / 4,957 (4,540 residential) |
| Median footprint | 152 m² |
| Imagery dates | 2013-07 to 2025-10 |
| E911 points (5,300) **inside** a footprint | 3,587 (68%) |
| E911 points within 30 m of a footprint | 5,000 (94%) |
| E911 points with **no** footprint within 100 m | 110 (2%) |

So ~94% of Freeport's addresses have a plausible "true building", which is
the ceiling for the right-building metric. The 2% with nothing nearby are
likely buildings under the source's 450 sq ft cutoff (small camps and
cottages, common in Maine) or newer than the imagery.

### Stage 1b: Street identification (labels → TIGER roads)

Street shapefiles are an input on equal footing with buildings: before a
building can be matched to "Rogers Road", we need to know **which TIGER
segments are Rogers Road**. Measured on Freeport (2026-11-02, a quick
check with crude suffix normalization only): **161 of 492 E911 street
names (~1,020 of 5,300 addresses, ~19%) don't match any TIGER name in
Freeport's ZIPs.** Spot checks show three different causes:

| Cause | Freeport example | Fix |
|---|---|---|
| Naming differences | "SOUTH FREEPORT ROAD" vs `S Freeport Rd`; "US ROUTE ONE" vs `US Hwy 1` / `US Rte 1` (TIGER alias in `street_names`) | Full name normalization (directionals, suffixes, number words, route names) + TIGER's `street_names` aliases |
| ZIP-scoped lookup misses the street | Matching only within the town's ZIPs is fragile (TIGER ZIPs follow USPS delivery areas, not town lines) | Match by name **and location** (segment near the label points), not by ZIP |
| Road not in TIGER at all | "SOMERSET CONDOS", "FREEPORT VILLAGE STATION" (condo complexes, a shopping center), private ways; **"ROGERS ROAD" (97 addresses)**: half its points have no TIGER segment within 150 m, and the nearest TIGER `Rogers Rd` is 5.8 km away in another town | Recorded as unmatched with a reason; see "Roads TIGER doesn't have" below |

(Correction, after Stage 1b was built: the first draft of this table said
Freeport's Rogers Road was in TIGER under Yarmouth's ZIP. That `Rogers Rd`
is a different road 5.8 km away; Freeport's is missing from TIGER.)

So street identification is its own stage: for each region's label street
names, find the TIGER segments they correspond to using name similarity
**plus** spatial agreement with that street's label points. The same
matching is needed in unlabeled regions too (the address the user types
must still find its road), so it's part of the pipeline, not a
training-only step. Its own accuracy is reported per region, because every
address on an unmatched street is lost before the model ever sees it.

**Built** (`address_inference/street_names.py`, `street_match.py`, tests
in `tests/test_address_inference_streets.py`):

```
python -m address_inference.street_match "dbname=geocoding" me --town Freeport
```

- `canonical()` normalizes both sides the same way: directionals,
  USPS abbreviations TIGER actually uses (wherever they appear, e.g.
  "Mast Lndg Rd"), `SAINT`→`ST`, and route names ("US ROUTE ONE",
  "ROUTE 1", "US Hwy 1" → `RTE 1`; "INTERSTATE 295", "I- 295" → `I 295`).
- Candidates: every TIGER name (primary + `street_names` aliases) on a
  segment within 150 m of the street's own E911 points. ZIP is not used.
- Decision, in order: **exact** canonical name (any support: TIGER's road
  often stops short of newer houses, e.g. Cortland Rd at 8%), **base_name**
  (same name apart from the road-type word, ≥50% support: "ROOS HILL
  DRIVE" vs `Roos Hill Rd`, "SOMERSET CONDOS" vs `Somerset`; sometimes a
  lane off a same-named road, so later stages can trust it less),
  **fuzzy** (≥0.85 similarity, ≥60% support: "MALLETT DRIVE" vs
  `Mallet Dr`). Otherwise unmatched, as **no_road_nearby** (<50% of points
  have any TIGER segment, named or not, within 150 m) or **name_mismatch**
  (points sit beside a differently named road). Never forced onto the
  nearest road.
- Writes `address_inference.street_matches` (one row per label street,
  with method/reason, support, nearest TIGER name) and
  `street_match_segments` (label street → tlid), replacing the town's
  previous rows on re-run.

**Freeport results (2026-11-02):**

| Outcome | Streets | Addresses |
|---|---|---|
| exact | 339 (68.9%) | 4,541 (85.7%) |
| base_name | 29 (5.9%) | 219 (4.1%) |
| fuzzy | 11 (2.2%) | 49 (0.9%) |
| **matched total** | **379 (77.0%)** | **4,809 (90.7%)** |
| no_road_nearby | 30 (6.1%) | 198 (3.7%) |
| name_mismatch | 83 (16.9%) | 293 (5.5%) |

So ~91% of Freeport's addresses reach a TIGER road; the other ~9% are on
roads TIGER lacks (mostly short private ways and condo loops: 83 streets
average 3.5 addresses each), which no TIGER-based method can place on
their own street. The `alias` method never fired in Freeport: canonical
route names already make "US ROUTE ONE" equal TIGER's primary `US Hwy 1`.

**Roads TIGER doesn't have** (private ways, condo loops, new subdivisions):
- First, measure: buildings far from any TIGER road and clustered together
  are a strong sign of a missing road. Report these per region.
- Later options, each with its own trade-off: OSM roads/driveways (good
  coverage, but ODbL, so kept out of geocoding results per
  `DATA_SOURCES.md`), state road layers (Maine DOT/GeoLibrary, license to
  check), or extracting roads from aerial imagery (Phase 4 territory).

### Stage 2: Attach buildings to street segments

For each building centroid, the nearest TIGER segment that **has address
ranges** (non-empty `lfromadd/ltoadd` or `rfromadd/rtoadd`), within 200 m.
Every *other* segment within 200 m is kept as well (as a candidate road,
not just the nearest), since the nearest road is often not the one the
building is addressed on:

- `side`: which side of the segment's digitized direction the building is on
  (sign of the cross product). It is **not** inferred from house-number
  parity: per `CLAUDE.md`, TIGER has no fixed odd/even side, so the side's
  own range is read from that segment.
- `t`: the building's projected position along the segment, 0..1
  (`ST_LineLocatePoint`), so it can be compared to range interpolation.
- `dist_m`: distance to the centerline, used later to tell houses from
  back-lot outbuildings.

Known hard cases, recorded rather than silently "fixed": a corner building
nearer the cross street than the street it's addressed on; long driveways
(nearest segment may be the wrong road); buildings beyond 200 m.

**Built** (`address_inference/attach.py`, tests in
`tests/test_address_inference_attach.py`):

```
python -m address_inference.attach "dbname=geocoding" me --town Freeport
python -m address_inference.attach "dbname=geocoding" me --county 23005
python -m address_inference.attach "dbname=geocoding" me    # whole state, county by county
```

- One row per (building, addressable segment within 200 m) in
  `address_inference.building_segments` (partitioned by state): `side`,
  `t`, `dist_m`, `rank` (1 = nearest), plus `at_end` (the building
  projects past the segment's end, i.e. beside its extension, not the
  road itself) and `range_on_side` (that side has an address range).
  `side` is NULL in the rare exactly-collinear case.
- Segments with no address range on either side (highways, unnamed
  connectors) are never candidates.
- Uses the building's `inner_point` (inside the footprint), not its
  centroid.
- Re-running replaces only the rows of the buildings in scope.

**Side convention check:** on Freeport's E911 points (exact-matched
streets, nearest matched segment), where the house number fits only one
side's range, the computed side agreed with that side **95.6%** (left,
1,577 / 1,650) and **95.2%** (right, 1,541 / 1,619) of the time. That
confirms the L/R convention matches TIGER's ranges; the ~5% disagreement
is the misplacement the model will have to learn around.

**Freeport results (2026-11-02):** 28,195 rows in ~1 s. Of the 4,957
buildings inside Freeport:

| | |
|---|---|
| Median candidate segments per building | 4 |
| Median / p90 distance to nearest addressable segment | 39 m / 110 m |
| Nearest segment has a range on the building's side | 4,209 (85%) |
| Nearest segment is only beside its extension (`at_end`) | 796 (16%) |
| **No addressable segment within 200 m** | **375 (7.6%)** |

The 7.6% with no candidate are mostly on roads TIGER lacks (consistent
with Stage 1b's 9% of addresses on unmatched streets) or far down long
rural driveways. M1–M3 fall back to M0 for them; whether the radius
should grow for rural areas is a question for the Stage 4 error map.

### Stage 3: Prediction methods

All methods produce a predicted point for each `(number, street, ZIP)` drawn
from the E911 list, using only TIGER + footprints.

- **M0, baseline: today's interpolation.** The existing interpolated
  point (20 ft offset), computed with the same logic as `interpolate.py` /
  `geocodeMatching.js`, so the baseline is what Meridian returns today, not
  an approximation of it.
- **M1, snap to nearest building.** Interpolate as in M0, then move to the
  centroid of the nearest building on the **same segment side**. Smallest
  change to today's behavior; if it wins, it's the easiest to ship.
- **M2, rank order along the side.** Sort the side's buildings by `t`,
  spread the side's range numbers over them in order (respecting the
  range's direction, low-to-high or high-to-low), and pick the building
  whose rank best fits the requested number. This fixes interpolation's
  "evenly spaced numbers" assumption directly.
- **M3, M2 with outbuilding filtering.** As M2, but first drop buildings
  that are likely not addressable: `OCC_CLS` not residential/commercial,
  small area (threshold tuned on half of Freeport, tested on the other
  half), or set behind a larger building on the same lot.

M1–M3 fall back to M0 when a segment side has no buildings.

### Stage 4: Scoring

For each E911 address that TIGER can also find (same street + ZIP + a
covering range; ones it can't are counted, not scored):

- **Distance error (m):** predicted point to E911 point. Report median,
  p90, and the share within 15 m / 30 m / 50 m. Headline number:
  **median error vs M0**.
- **Right building (%):** the E911 point's "true building" is the footprint
  that contains it, or the nearest one within 30 m (E911 points sit on or
  near the structure). A prediction is a hit if it picked that building.
  Addresses with no true building (no footprint nearby) are excluded and
  counted.
- **Breakdown** by street type (village / suburban / rural, by buildings
  per km of segment) and by MTFCC.
- **Error map:** a QGIS-ready layer of prediction → truth lines, so the
  worst misses can be looked at, not just counted.

The tuning/test split for M3's thresholds is by **street**, not by address,
so streets in the test half are never seen during tuning.

## Machine learning: E911 as training labels

Maine's E911 is not just the answer key, it's ~798K **labeled examples**:
for each one we know the address *and* which building it really is. That
turns "which building is 49 Main St?" into a supervised learning problem,
and every case where the geometry methods (M1–M3) pick the wrong building
becomes a training example that teaches the model the correction.

### Task: rank candidate buildings for an address

For one address (number + street + ZIP):

1. **Candidates**: the buildings attached (Stage 2) to segments of that
   street in that ZIP, nearest ~15 to M0's interpolated point.
2. **Label**: 1 for the true building (Stage 4's definition), 0 for the rest.
   Addresses whose true building isn't among the candidates are dropped
   from training and counted (they measure the candidate step's recall,
   a ceiling on any model).
3. **Model**: gradient-boosted trees in learning-to-rank mode (LightGBM
   `lambdarank`), one query group per address. Runs on CPU in minutes, and
   shows which features matter (feature importance), so the model's
   corrections can be explained rather than trusted blindly.
4. **Prediction**: the top-ranked building's centroid. If its score is
   below a confidence threshold, fall back to M0 and flag the result
   `approximate`, the same convention as `rangeGapFallback`.

### Features (per address–building pair)

- **Geometry vs. range:** `t` vs. the address's interpolated fraction; the
  building's rank on its side vs. the number's rank in the range (M2's
  logic, as a feature instead of a rule); distance to M0's point.
- **Side:** whether the building's side matches the side whose range holds
  this number with this parity (per `CLAUDE.md`, read from the segment's
  own ranges, never a fixed odd/even rule).
- **Building:** area, `OCC_CLS` / `PRIM_OCC`, distance to centerline, whether
  a larger building sits closer to the road (garage/barn signal).
- **Road network (from the street shapefiles):** distance to the
  addressed street vs. the nearest *other* street (corner lots, long
  driveways); distance to the nearest intersection; whether the building
  faces the addressed street (footprint's long side vs. street bearing);
  road class (MTFCC: a house is rarely addressed on a limited-access
  highway it happens to sit next to); whether a straight line from the
  building to the addressed street crosses another road.
- **Context:** buildings per km on the segment (village vs. rural), segment
  length, MTFCC, number of addresses the range implies vs. buildings
  actually present on that side; the street-identification confidence
  from Stage 1b.
- **Imagery (Phase 4 only):** features from a vision model on NAIP tiles.

The geometry methods M1–M3 stay in place as baselines: the model has to
beat them on the test set to earn its place.

### Training and testing without fooling ourselves

- **Split by town, not by address.** Neighbors on one street are nearly
  copies of each other; a random split would let the model memorize a
  street and score unrealistically well. Train on most Maine towns, tune
  on a few, and test on held-out towns never seen in training.
  Freeport is a **test** town.
- **Test towns are stratified**: at least one dense (Portland), one
  suburban (Freeport), one rural (Farmington), since NH will have all three.
- **The "correction loop"**: after each training run, the error map
  (Stage 4) shows the test-set misses; each fix is a new feature or a
  candidate-step change, then retrain and rescore. Changes are kept only
  if they help the held-out towns, not just the training ones.

### Environment

The project `.venv` has no ML libraries yet. Adds: `lightgbm`, `numpy`,
`pandas` (and `scikit-learn` for metrics), experiment-only, listed in
`experiments/building_addresses/requirements.txt`, not the main
requirements. Training data size: ~798K addresses × ≤15 candidates ≈ 12M
rows × ~20 features as float32, roughly 1 GB, which fits on this machine
(14 cores, 14.6 GB RAM) with Ollama stopped.

## Scaling to more places

Freeport is the first test, not the shape of the system. Everything above
is built around a **region** so that adding a new place is configuration
plus data, not new code.

### Regions and source adapters

A region is one config entry:

TOML rather than YAML, since Python reads it with no extra dependency
(`tomllib`). `address_inference/regions/me.toml` today has `id`, `name`,
`state_fips`, `state_abbr`, `[footprints]` and `[[labels]]`; the
`boundary`/`partition_by`/`streets` keys below are planned:

```toml
# address_inference/regions/me.toml (planned shape)
id = "me"
name = "Maine"
state_fips = "23"
state_abbr = "ME"
partition_by = "county"          # unit of parallel work
[streets]
source = "tiger"                 # already nationwide
[footprints]
source = "usa_structures"
labels:                          # optional: regions without labels can
  - {source: maine_e911}         # still be predicted, just not trained/scored
```

Each `source` is an **adapter**: a small module with one job (fetch +
normalize into a common table shape) and its own license note. Footprints
and labels from different publishers all land in the same two tables, so
Stages 2–4 and training never know where the data came from.

| Adapter kind | First implementation | Later ones |
|---|---|---|
| `footprints` | `usa_structures` (FEMA, nationwide) | Maine GeoLibrary, county layers |
| `labels` | `maine_e911` (the existing `address_points` table) | **`nad`** (US DOT National Address Database), state/county E911 feeds |
| `streets` | `tiger` (existing `streets`) | none needed |

**Where more labels come from:** per `DATA_SOURCES.md` §2, the National
Address Database already has full open point coverage for 24 states + DC.
Every one of them is a region we can **train and score** on, not just
predict. That's what makes per-place training realistic. (NAD's license and
per-state terms are to be verified before ingest, the same as FEMA's.)

### Data layout at scale

- All experiment/inference tables live in schema `address_inference`
  (not `address_inference`), with `region_id` and `partition_id` (county
  FIPS) on every row, and tables **list-partitioned by state**. Loading,
  attaching and featurizing run per county, so they parallelize, and a
  re-run of one county never touches the others.
- Size estimate: USA Structures is on the order of 100M+ buildings
  nationwide, i.e. tens of GB in Postgres with geometry. That's fine for a
  few states on one box; nationwide would be its own capacity decision,
  not a redesign.

### Models: one base, specialized where data allows

Different places number differently (rural route conventions, grid cities,
hyphenated Queens-style numbers), so one model won't fit everywhere. But
most of what the ranker learns ("bigger building nearer the road is the
house, order along the street follows the numbers") is universal. So:

1. **Base model** trained on every labeled region together, with region
   context as features (state, density class, median lot size). Used for
   any region with no labels of its own.
2. **Region models** for labeled regions, trained (or fine-tuned from the
   base, LightGBM's `init_model`) on that region only. **A region model
   is used only if it beats the base model on that region's held-out
   towns.** Otherwise the base model stays.
3. **Transfer test before trusting the base model anywhere new:**
   leave-one-state-out. Train on all labeled states but one, score on the
   one left out. That's the honest estimate of accuracy in an unlabeled
   state like NH, and it's reported per state.

### Model registry

Every trained model is saved with what it needs to be reproduced and
judged:

```
address_inference/models/<model_id>/
  model.txt            # LightGBM model
  meta.json            # feature schema version, training regions + data
                       # vintages, code commit, hyperparameters
  metrics.json         # per held-out region/town: median error, right-
                       # building %, vs. M0–M3
```

A small `region_models` table maps each region to the model that serves
it. Swapping a model is changing that row, after its metrics are better.
**Feature schema is versioned**: a model only runs against features built
with the same version, so adding a feature never silently breaks an older
model.

### Serving (only after Phase 3 passes)

Predictions are **precomputed in batch** per region, not run per request:
one row per (address, building) in an `inferred_address_points` table
with `model_id`, confidence, and data vintages. Lookup order in
`geocode.js` would become:

1. real address points (E911, NAD) → exact,
2. inferred point with confidence above threshold → flagged
   `source: 'inferred_building'`,
3. TIGER interpolation → as today.

So the server stays a plain, fast lookup; models never run in the request
path, and a bad model can be rolled back by region without a deploy. This
is a production change and gets its own design doc when we get there.

### Adding a new place (the target workflow)

1. Write `regions/<id>.toml` (and an adapter only if its data source is new).
2. `python -m address_inference.run <id>`: load → attach → featurize, per
   county in parallel.
3. Labeled region: train/fine-tune, compare against the base model, register
   the winner. Unlabeled: run the leave-one-state-out numbers for the most
   similar states, hand-check a sample.
4. Batch-predict, review metrics, point `region_models` at the model.

## Phases and decision points

1. **Phase 1: geometry baselines.** Stages 1–4 with M0–M3, on Freeport
   first. They set the bar the model has to beat, and their misses show
   what the model needs to learn.
2. **Phase 2: statewide data.** Run Stages 1–2 for all of Maine, to produce
   the ~798K-address training set.
3. **Phase 3: learned ranking (core).** Train the ranker on the town split
   above and score it on the held-out test towns against M0–M3.
   **Continue if** it cuts M0's median error by ≥ 40% *and* picks the right
   building ≥ 70% of the time on the held-out towns.
4. **Phase 4: imagery features (optional).** For the cases the ranker is
   least sure about (e.g. house vs. garage), add features from a vision
   model on NAIP aerial tiles (USDA, public domain): first a small
   pretrained image model's embedding, then Qwen-VL answers ("is this a
   house, garage, barn?") if that isn't enough. Measured as "points gained
   over Phase 3" on the same held-out towns. Run on a GPU machine, not this
   laptop (≈30 s/image on CPU), and only on the uncertain cases.
5. **Phase 5: second labeled state.** Add one NAD state through the
   region/adapter path (no new pipeline code). This proves the scaling
   design and enables the first leave-one-state-out transfer test.
6. **Phase 6: NH.** Apply the base model to NH. There's no answer key
   there, so the transfer test from Phase 5 is the accuracy estimate, plus a
   hand-checked sample against public imagery before any production use.

## File layout

```
address_inference/                 # own package, separate from geocoding/
  regions/me.toml                  # one file per region
  sources/
    footprints_usa_structures.py   # Stage 1 adapters
    labels_maine_e911.py
    labels_nad.py                  # Phase 5
  pipeline/
    street_match.py                # Stage 1b, label streets -> TIGER segments
    attach.py                      # Stage 2 (SQL inside, per county)
    baselines.py                   # Stage 3, M0–M3
    features.py                    # versioned feature schema
    train.py                       # LightGBM lambdarank, town/state splits
    score.py                       # Stage 4 + reports + QGIS layers
  registry.py                      # models/ + region_models
  run.py                           # python -m address_inference.run <region>
  requirements.txt                 # lightgbm, numpy, pandas, sklearn
  models/                          # trained models (gitignored, backed up)
  results/                         # generated reports (gitignored)
tests/address_inference/           # same throwaway-DB pattern as
                                   # tests/conftest.py's `dsn` fixture
```

`address_inference/` is its own package so nothing experimental becomes
importable by `geocoding/`'s ingest pipeline by accident. It reads
`streets` and `address_points` and writes only to its own schema.

## Risks

- **Footprint gaps or misalignment.** If USA Structures is missing
  buildings in Freeport or is offset from E911, scores drop for reasons
  unrelated to the method. Mitigation: report the "no true building"
  count first; compare to the Maine GeoLibrary layer if it's high.
- **TIGER range gaps.** Addresses outside every TIGER range can't be
  predicted by any method; counted separately so they don't look like
  method failures.
- **Multi-unit buildings and plazas.** Several addresses, one footprint (or
  one address, several footprints). Scored but reported as their own
  category.
- **E911 point placement.** If some E911 points sit at the driveway rather
  than the structure, "right building" is computed with the 30 m nearest
  fallback; the distance metric is unaffected.

## Open questions

1. ~~USA Structures endpoint and Maine coverage~~ **Resolved
   2026-11-02:** Esri's `USA_Structures_View` FeatureServer, ~924K Maine
   structures, imagery 2013–2025 in Freeport.
2. ~~License~~ **Resolved 2026-11-02: CC BY 4.0, not public domain.**
   Attribution required on anything shipped; recorded in
   `DATA_SOURCES.md` §4. The National Address Database's terms are still
   to check before Phase 5.
3. **Thresholds.** 200 m attach radius, 30 m true-building fallback, and the
   ≥40% / ≥70% go/no-go numbers are starting values, not measured. Revisit
   after the first run.
