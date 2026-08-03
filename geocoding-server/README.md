# geocoding-server

Express API that resolves a free-text address to coordinates using the
`streets` table in [geocoding.sqlite](C:\software\database\sqlite3\geocoding.sqlite)
(built by the [geocoding](../geocoding) Python project from TIGER/Line
edges).

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

Env vars (all optional):

- `GEOCODING_DB_PATH` — defaults to `C:\software\database\sqlite3\geocoding.sqlite`
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
