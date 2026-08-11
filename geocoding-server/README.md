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
3. **Odd** house numbers are interpolated against the segment's
   **left** range (`lfromadd`/`ltoadd`) and offset to the **left** of
   the centerline; **even** numbers use the **right** range
   (`rfromadd`/`rtoadd`) and offset **right**. The offset distance
   defaults to 20 feet (`OFFSET_FEET` env var).
4. The first candidate segment whose range actually contains the
   number is used for interpolation.

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
(`"source": "address_point"` vs `"interpolation"`), so callers can tell
a real point from an estimate.

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
