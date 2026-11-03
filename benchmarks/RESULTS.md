# Geocoding accuracy benchmark: progress log

Internal record of how accurately Meridian geocodes compared with other
geocoders, re-run over time so progress (or regressions) are visible.
**Internal only**: the terms of some commercial geocoders (Google, Esri)
may restrict publishing comparisons, so check them before quoting their
numbers anywhere public.

## How it's measured

- **Sample:** `data/maine_e911_300.csv`, 300 Maine addresses drawn at
  random (fixed seed, 155 towns) from Maine's E911 address points and
  frozen, so every run scores the same addresses. Each address is given
  to every service as one line with no ZIP, e.g. `440 Taber Hill Road,
  Vassalboro, ME`.
- **Truth:** the address's E911 point, a surveyed per-structure location.
- **Found:** the service returned a location at all.
- **Within 25 / 50 / 150 m:** returned a location that close to the
  truth. Percentages are of all 300 addresses, so "not found" counts as a
  miss. **Within 50 m is the headline "success" number** (roughly "on
  the right property").
- **Wrong place:** returned a location more than 500 m from the truth.
- **Median / p90 error:** meters off, over found addresses only.

**Meridian is scored two ways.** "As shipped" uses Maine's E911 points
itself, so on this sample it's close to perfect by construction: that
row shows what Maine customers get, not how good the method is. "TIGER
only" skips E911: it's what every place without E911 data (all of NH)
gets today, and **the row the building-inference work is meant to
improve.** The US Census Geocoder is the closest peer to it (same TIGER
address ranges).

Run with `python -m benchmarks.run` (see `benchmarks/run.py`). Google and
Esri rows appear once `GOOGLE_MAPS_API_KEY` / `ARCGIS_API_KEY` are set.
Per-address results for each run are in `runs/` (error in meters only,
never a third-party service's coordinates).

## Current standings: Meridian vs. Esri vs. Google (and others)

Latest result per service on the same 300 Maine addresses
(`maine_e911_300`). Update this table whenever a new run changes a
service's numbers; the dated history is in "Results" below.

| Rank | Service | As of | Found | **Within 50 m** | Within 25 m | Wrong place (>500 m) | Median error | p90 error |
|---|---|---|---|---|---|---|---|---|
| 1 | **Meridian, as shipped** (with PR #114) | 2026-11-03 | 100% | **99.3%** | 99.3% | 0.0% | 0 m | 0 m |
| 2 | Esri ArcGIS geocoding | 2026-11-03 | 100% | 97.3% | 95.7% | 0.0% | 0 m | 3 m |
| 3 | Nominatim (OpenStreetMap) | 2026-11-03 | 98.0% | 90.0% | 85.0% | 1.3% | 1 m | 34 m |
| 4 | Google Geocoding API | 2026-11-03 | 100% | 89.7% | 86.3% | 2.3% | 3 m | 52 m |
| 5 | US Census Geocoder | 2026-11-03 | 91.3% | 39.3% | 18.3% | 6.0% | 60 m | 262 m |
| 6 | Meridian, TIGER only (no E911; what NH gets) | 2026-11-03 | 82.3% | 38.0% | 17.0% | 3.3% | 57 m | 250 m |

How to read it:
- **In Maine, Meridian is now the most accurate of the five**, because it
  uses the state's E911 points directly and (since PR #114) no longer
  skips the 16% that share an address. Esri is close behind and likely
  uses the same E911 data. Google is accurate when it labels a result
  `ROOFTOP` (92.3% within 50 m) but always returns *something*: its
  `APPROXIMATE` results were all several km off.
- **Outside E911 coverage, Meridian is no better than the Census
  Geocoder** (both interpolate TIGER ranges, ~38-39%). That's the gap
  the building-inference work (docs/superpowers/specs/
  2026-11-02-building-address-inference-design.md) is aimed at; its
  Freeport model reached 46.6% within 50 m vs 24.5% for interpolation
  there (Freeport only, not this sample).
- These are Maine-only results on a sample where E911 is the truth, which
  favors E911-based services. NH, where nobody has E911, would look
  different.

## Notes on runs

- **2026-11-03, first run** (commit `af1dc7c-dirty` = master plus the
  then-uncommitted benchmark code):
  - **Meridian as shipped: 45 of 300 (15%) didn't use their own E911
    point** and fell back to interpolation (one, 765 Roosevelt Trail,
    Windham, landed 1 km off). Cause: 16% of all Maine E911 points share
    their exact number + street + town with other points (one per unit in
    apartment complexes and mobile-home parks; 765 Roosevelt Trail has
    1,815), and the address-point lookup only accepts a single match.
    A fix candidate, not done yet.
  - **Nominatim is nearly as good as E911 itself** (median 1 m). Likely
    because OpenStreetMap's Maine house addresses come largely from the
    same state E911 data; not verified. So in Maine it's really a
    comparison with E911, not with an independent method.
  - **Meridian TIGER only ≈ US Census Geocoder** (38.0% vs 39.3% within
    50 m), as expected: both interpolate along the same TIGER ranges.
    That ~38% is the bar the building-inference work has to raise.
- **2026-11-03, Google added** (same sample, commit `f8c483a`):
  - Found all 300; **89.7% within 50 m**, median 3 m. Close to E911-based
    services in Maine (Meridian as shipped 93.0%, Nominatim 90.0%).
  - Its own precision labels mostly hold up: `ROOFTOP` (284 results) was
    within 50 m 92.3% of the time, median 3 m. But its 3 `APPROXIMATE`
    results were all wrong places (median 6.4 km off), and that's what
    makes up its 2.3% "wrong place": Google always returns *something*,
    and the label is the only warning.
  - Cost: 300 requests on the Geocoding API.
- **2026-11-03, Esri added** (same sample, commit `fad7ea0`):
  - **Best of all services: 97.3% within 50 m**, median 0 m, p90 3 m, no
    wrong places. Every result was a `PointAddress` match. Median 0 m means
    it returns the E911 points themselves, so Esri very likely uses Maine's
    E911 data as its source here (not verified).
  - **It beats Meridian as shipped (93.0%) for a fixable reason:** both
    start from the same E911 points, but Meridian falls back to
    interpolation for the 15% of addresses whose E911 point is one of
    several sharing the address (see the first run's note). Fixing that is
    the clearest way to close the gap.
  - Cost: 300 geocodes (not stored), within Esri's free tier.
- **2026-11-03, shared-address fix** (PR #114, commit `616b8d7`, measured
  before merging, with the fix applied on top of this benchmark):
  - **Meridian as shipped: 93.0% → 99.3% within 50 m**, found 98.3% →
    100%, wrong place 0.3% → 0%. All 300 addresses now resolve to E911
    points (was 255). Ahead of Esri (97.3%) and Google (89.7%) in Maine.
  - The 2 addresses still beyond 50 m are units in shared-address groups:
    the fix returns the unit nearest the group's center, which can be a
    different unit than the one sampled.
  - TIGER only is unchanged (the fix only touches E911 matching), so
    only the as-shipped row was re-recorded.

## Results

| Date | Commit | Sample | Service | Mode | Found | ≤25 m | ≤50 m | ≤150 m | Wrong place (>500 m) | Median error (m) | p90 error (m) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | af1dc7c-dirty | maine_e911_300 | Meridian | as shipped (E911 + TIGER) | 98.3% | 88.3% | 93.0% | 97.7% | 0.3% | 0 | 24 |
| 2026-11-03 | af1dc7c-dirty | maine_e911_300 | Meridian | TIGER only (no E911) | 82.3% | 17.0% | 38.0% | 66.0% | 3.3% | 57 | 250 |
| 2026-11-03 | af1dc7c-dirty | maine_e911_300 | US Census Geocoder | Public_AR_Current | 91.3% | 18.3% | 39.3% | 72.0% | 6.0% | 60 | 262 |
| 2026-11-03 | af1dc7c-dirty | maine_e911_300 | Nominatim (OpenStreetMap) | public API | 98.0% | 85.0% | 90.0% | 94.0% | 1.3% | 1 | 34 |
| 2026-11-03 | f8c483a | maine_e911_300 | Google Geocoding API | geocode/json | 100.0% | 86.3% | 89.7% | 95.7% | 2.3% | 3 | 52 |
| 2026-11-03 | fad7ea0 | maine_e911_300 | Esri ArcGIS geocoding | findAddressCandidates | 100.0% | 95.7% | 97.3% | 99.7% | 0.0% | 0 | 3 |
| 2026-11-03 | 616b8d7 (PR #114) | maine_e911_300 | Meridian | as shipped (E911 + TIGER) | 100.0% | 99.3% | 99.3% | 100.0% | 0.0% | 0 | 0 |
