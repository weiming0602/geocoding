# Data model

> Reflects the actual Postgres schema as ingested/queried today. Field
> provenance and licensing are covered in [DATA_SOURCES.md](../DATA_SOURCES.md);
> this document is about structure, not sourcing.

## Two databases

| Database | Access | Contents |
| --- | --- | --- |
| `geocoding` | Read-only from the API (enforced at the Postgres session level) | `streets`, `street_names`, `address_points` |
| `geocoding_users` | Read-write | `users`, `feedback` |

They're never joined across — the API opens two entirely separate
connection pools and nothing in the codebase queries one database using
a value from the other beyond passing an email/service-key string
between requests.

## `geocoding` database

### `streets`

One row per TIGER/Line **edge** (a street segment, not a whole street —
a single named street is typically split into many rows, each covering
a different address sub-range).

| Column | Notes |
| --- | --- |
| `id` | Local primary key |
| `tlid` | TIGER's own segment ID — unique, used for idempotent re-ingestion |
| `fullname` | The segment's primary name |
| `lfromadd` / `ltoadd` | House-number range on the **left** side |
| `rfromadd` / `rtoadd` | House-number range on the **right** side |
| `zipl` / `zipr` | ZIP on each side — can differ where a street runs along a ZIP boundary |
| `mtfcc`, `statefp`, `countyfp` | Raw TIGER classification/geography codes |
| `state`, `state_abbr` | Full name and USPS abbreviation |
| `geometry` | The segment's shape as WKT text — what the app's own interpolation math actually parses |
| `minx`/`miny`/`maxx`/`maxy` | Precomputed bounding box, for a cheap pre-filter before any string/geometry work |
| `geom` | The same shape as a native PostGIS `Geometry` (not `LineString` — a shapefile edge can have multiple parts) — exists so the table opens directly as a spatial layer in QGIS; not queried by the app itself today |

Indexed on: `tlid` (unique), `fullname`, `(zipl, zipr)`, bounding box,
`state`/`state_abbr`, and several composite `UPPER(fullname)`-led
indexes matching the app's actual query shape (see the inline rationale
in `schema.py` — the plain `fullname` index can't serve a
case-insensitive comparison, which is what every real query runs).

### `street_names`

One row per **alias** a TIGER segment is known by (a numbered route and
a local name are often the same physical segment) — including the
segment's own primary name, so this table, not `streets.fullname`
directly, is what every name-matching query actually runs against.

| Column | Notes |
| --- | --- |
| `id` | Local primary key |
| `tlid` | Foreign segment reference (no DB-level FK — matched by convention) |
| `fullname` | This alias's text |
| `paflag` | TIGER's primary/alias flag |
| `zipl` / `zipr`, `state`, `state_abbr` | **Denormalized copies** of the owning `streets` row's values, kept in sync at ingest time — a deliberate duplication (measured ~15x faster than joining back to `streets` per matched row at batch scale) |

Unique on `(tlid, fullname)` (what makes re-ingestion idempotent), plus
the same composite `UPPER(fullname)`-led and ZIP-led indexes as
`streets`, for the same reason.

### `address_points`

One row per real, surveyed Maine E911 address point — a fundamentally
different kind of row than `streets`: an exact location, not a range to
interpolate along.

| Column | Notes |
| --- | --- |
| `id` | Local primary key |
| `site_uid` | The source system's own stable ID (unique — what makes re-ingestion idempotent) |
| `address_number` | The house number itself |
| `street_fullname` | Street name as E911 spells it (often the unabbreviated form — "Drive" not "Dr" — reconciled at query time, not ingest time, via `expandStreetSuffix()`) |
| `town`, `county` | E911 is keyed by **town**, not ZIP — ZIP is a TIGER/USPS concept, not part of this dataset at all |
| `state_abbr` | Carried per-row rather than assumed "ME", since the schema itself doesn't rule out another state ever contributing data the same way |
| `geom` | The actual surveyed point, `Point` geometry |

Indexed for the app's real lookup key: unique on `site_uid`; a
town-led composite `(UPPER(town), UPPER(street_fullname),
address_number, state_abbr)` for the common case; a town-less fallback
`(UPPER(street_fullname), address_number, state_abbr)` for addresses
with no parsed town; and a GiST index on `geom`.

**No ZIP column exists here at all** — a caller-supplied ZIP can only be
cross-checked indirectly, against `street_names`' ZIPs for the same
street name (see [ARCHITECTURE.md](ARCHITECTURE.md)'s forward-geocoding
section).

## `geocoding_users` database

### `users`

One row per paying (or free-tier) account. No password, no session —
identity is the email + a generated `service_key`.

| Column | Notes |
| --- | --- |
| `id` | Local primary key |
| `email` | Unique — the account's identity |
| `tier` | Total monthly address quota |
| `period_start` | Tracks which billing month `used_this_period` applies to, so it can roll over |
| `used_this_period` | Consumed quota this period |
| `service_key` | Unique, opaque — generated once, required (alongside the email) for every batch endpoint; a `GET /quota` lookup only needs the email, since it can't spend anything |

### `feedback`

One row per submission through the in-app feedback form. No listing or
reply endpoint exists — reviewing and replying is manual (`psql` +
email), same as account creation itself.

| Column | Notes |
| --- | --- |
| `id` | Local primary key |
| `name`, `email` | Optional — whoever submitted it |
| `message` | Required |
| `created_at` | Defaults to `now()` |

## What's deliberately *not* modeled

- No `orders`/`transactions` table — a PayPal purchase is captured,
  verified, and immediately folded into `users.tier`/`used_this_period`;
  there's no persistent record of individual purchases beyond PayPal's
  own transaction history.
- No foreign keys between `streets`/`street_names`/`address_points` —
  they're matched by convention (`tlid`, name/number/town), not
  database-enforced relationships, consistent with how the source data
  itself arrives (independently-published files, not a single relational
  export).
- No junction between `users` and `feedback` — feedback is anonymous by
  design (name/email are optional free text, not an account reference).
