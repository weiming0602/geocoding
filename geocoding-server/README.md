# geocoding-server

Express API that resolves a free-text address to coordinates using the
`streets` table in the `geocoding` Postgres database (built by the
[geocoding](../geocoding) Python project from TIGER/Line edges).
**Coverage: Maine and New Hampshire only** — no other US state or country.

## Matching logic

1. Parse the address into `{ number, streetName, zip }` (regex-based:
   leading house number, text up to the first comma or trailing state
   code as the street name, last standalone 5-digit run as ZIP).
2. Find every `streets` row where `fullname` matches (case-insensitive,
   exact then substring fallback) and `zipl` equals the parsed ZIP.
   A named street is usually split into many address-range segments,
   so all candidates are checked.
3. Each segment's two sides are checked: a side is used when its own
   ZIP matches and its range (`lfromadd`/`ltoadd` or
   `rfromadd`/`rtoadd`) holds numbers of the same parity and contains
   the house number. **Which side carries odd numbers isn't fixed** --
   TIGER's left/right follow the direction each segment happens to be
   digitized in (about 57% of Maine/NH segments have odd numbers on the
   right) -- so "odd -> left" is only the tie-breaker for the few
   segments with the same parity on both sides (`sideFraction()` in
   `src/geocodeMatching.js`). The point is interpolated along that range
   and offset to that side of the centerline, 20 feet by default
   (`OFFSET_FEET` env var).
4. The first candidate segment whose range actually contains the
   number is used for interpolation.
5. If none does, but the number sits in a small hole between two ranges
   on the same street, ZIP and side numbering -- TIGER often skips a
   few numbers between segments (Exeter NH's High St: odd 29-31, then
   37-53, so 33 and 35 match nothing) -- it's placed between the two
   ranges' facing ends and marked `"approximate": true`. Only when both
   neighbours exist (never past the street's first or last address),
   the gap is at most 50 numbers, and the two ends are within 150 m
   (`rangeGapFallback()`). Checked against Maine E911 points: median
   86 m from the real location, vs 54 m for ordinary interpolation.
   Anything else is a `422`.

Before any of the above, Maine addresses are checked against a real,
surveyed E911 address point (`address_points`, keyed on street name +
house number, narrowed by town) — see `matchAddressPoint()` in
`src/geocode.js`. address_points has no ZIP column of its own, so a
caller-supplied ZIP is cross-checked against `street_names`' ZIPs for
that street *only when street_names actually has an opinion*: a street
E911 covers but TIGER doesn't (no `street_names` row at all) is left
unchecked, but a street TIGER does know under a completely different
set of ZIPs is treated as a mismatch (not silently accepted), falling
through to the range-interpolation path instead, which does check ZIP
directly. State is checked directly against the point's own
`state_abbr`. Each response reports which path was used
(`"source": "address_point"` vs `"interpolation"` vs, for an
authenticated request only, `"llm_assisted"` when the address was
corrected via an LLM-assisted retry -- see `src/llmAssist.js` --
alongside `originalInput`/`correctedAddress` fields in that case), so
callers can tell a real point, a direct range match, and an
LLM-corrected guess apart.

**The named town comes before the ZIP.** After the address-point check
and before step 2, an address that names a town has its street looked
up *inside that town's boundary* (`towns`, Census county subdivisions --
see `geocoding/ingest_towns.py`), via `matchByStreetAndTown()` in
`src/geocodeMatching.js`. A segment counts as in the town when its
midpoint is (a neighbouring town's street that merely ends on the
boundary doesn't). Exact name only (no substring fallback -- with no ZIP
to narrow it, that would scan every street name). Within the town,
segments in the address's own ZIP are tried first, then any, and steps
3-5 run on those segments. If the town places it, that's the answer even
when the ZIP disagrees: `"10 Forest Ave, Lebanon, NH 03301"` (03301 is
Concord, which has no Forest Ave) matches Lebanon's Forest Ave, and
`"38 Franklin St, Derry, NH 03301"` matches Derry's Franklin St, not
Concord's. The response then carries `"matchedBy": "town"`,
`match.town`, and -- when the matched side's ZIP isn't the one given --
`"correctedZip"` (also a `correctedZip` column in batch `results.csv`).
Only when the town is unknown (not in `towns`, e.g. a village or postal
name like "West Lebanon"; or no `towns` table loaded yet), doesn't have
the street, or is ambiguous (same-named towns in ME and NH both having
it, with no state/ZIP to pick) does the ZIP path above run, unchanged.
If the town has the street but no range holds the number, and the ZIP
path finds no such street either, the town's `422` is returned. The
LLM-assisted retry also offers the named town's similarly spelled
streets ahead of the ZIP's, re-matches a town pick by town, and rejects
a ZIP-based pick more than 5 km outside the named town.

## Worked examples

**Odd → left.** Chestnut Rd's segment here covers the left-side range
1–99; house number 91 is odd, so it interpolates against that range
and lands on the left side of the centerline.

![Chestnut Rd #91, matched on the left side, range 1-99](../resources/location%20of%20Chestnum%20street%20num%2091%20left%20side.png)

**Even → right.** Sawyer Brook Rd's segment here covers the
right-side range 2–98; house number 26 is even, so it interpolates
against that range and lands on the right side of the centerline.

![Sawyer Brook Rd #26, matched on the right side, range 2-98](../resources/location%20of%20Sawyer%20brook%20rd%20street%20num%2026%20right%20side.png)

## Run

```bash
npm install
node src/server.js
```

Requires a local Postgres with the `postgis` extension, and a role that
can connect over the Unix socket without a password (peer
authentication) -- see the root [README](../README.md#setup).

Env vars (all optional):

- `GEOCODING_DSN` — defaults to `postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding`
- `USERS_DSN` — defaults to `postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users`
- `PORT` — defaults to `3001`
- `OFFSET_FEET` — defaults to `20`

## API

`POST /geocode`

```json
{ "address": "997 Pequawket Trl, Standish, ME 04091" }
```

Success (`200`):

```json
{
  "input": { "number": 997, "streetName": "Pequawket Trl", "zip": "04091" },
  "match": { "id": 12, "tlid": "78056932", "fullname": "Pequawket Trl", "zipl": "04091", "zipr": "04091" },
  "rangeSide": "left",
  "offsetSide": "left",
  "offsetFeet": 20,
  "coordinates": { "latitude": 43.83439, "longitude": -70.778549 }
}
```

Errors: `400` invalid input, `404` no matching street, `422` house
number outside every candidate segment's range. All return
`{ "error": "..." }`.

## Tests

```bash
node --test
```
