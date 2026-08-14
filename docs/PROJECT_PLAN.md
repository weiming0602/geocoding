# Project plan

> Reconstructed retrospectively from git history and the public progress
> timeline (`ui/shared/milestones.ts`) — phased as if written up front,
> but describing the order things were actually built in. Each phase
> lists what it delivered and why, not just what shipped.

## Phase 0 — Data foundation

**Goal:** a real, licensable street network to geocode against, before
any API existed.

- Ingest US Census TIGER/Line **edges** (street geometry + per-side
  address ranges) and **featnames** (name aliases) county-by-county
  (`ingest.py`, `ingest_featnames.py`).
- Build the core interpolation algorithm once, in Python
  (`interpolate.py`): parity decides left/right range, proportional
  distance along the segment's geometry, offset off the centerline.
- Public-domain data only (a deliberate constraint — TIGER/Line has
  full US coverage on its own, which is what makes it the right
  baseline layer regardless of what gets added later).

## Phase 1 — MVP geocoding API

**Goal:** prove the algorithm as a real service, Maine + New Hampshire
only, on purpose (not diluted across 50 states).

- Port the matching/interpolation logic to Node (`geocode.js`,
  `interpolate.js`) behind a single `POST /geocode` endpoint.
- Ship 2026-07-29.

## Phase 2 — Reverse geocoding and street aliases

**Goal:** round out the core lookup primitives before building anything
on top of them.

- `POST /reverse-geocode`: nearest segment, which side, interpolate a
  house number back out.
- Match against every known **alias** for a street (a numbered route
  and a local name resolving to the same segment), not just its primary
  TIGER name — via the `street_names` table.
- Shipped 2026-07-30 and 2026-08-01 respectively.

## Phase 3 — Two apps and a business model

**Goal:** turn a working API into something a real customer could find,
use, and pay for.

- Scaffold `ui/desktop` (React/Vite) and `ui/mobile` (Expo) against a
  shared `ui/shared` API client, rather than building one app and
  porting it later.
- Establish the "Classical" design system (see
  [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)) on both platforms from the
  start, not retrofitted.
- Add self-serve billing: PayPal one-time purchases for batch-quota
  packs, a generated `service_key` per account, quota tracked per
  billing month.
- Shipped 2026-08-02.

## Phase 4 — Move off SQLite before it became a real constraint

**Goal:** a database that could actually take concurrent production
traffic, ahead of adding more data (not after hitting a wall).

- Migrate both databases from SQLite (+ a bolted-on SpatiaLite
  extension for geometry) to Postgres/PostGIS.
- Split into two databases along a read-only/read-write line (see
  [ARCHITECTURE.md](ARCHITECTURE.md)) rather than keeping one database
  with mixed trust levels.
- Enforce the read-only boundary at the **session level**, not just by
  convention in application code, with a dedicated test guarding it.
- Shipped 2026-08-03.

## Phase 5 — Real accuracy, not just estimates (Maine)

**Goal:** close the gap on long rural roads, where range interpolation's
"evenly spaced houses" assumption breaks down visibly (measured ~200
feet off on a real Brunswick, ME address before this shipped).

- Ingest Maine's public E911 address-point feed (`address_points`) —
  the one state in-region with full open per-structure point coverage,
  confirmed directly against the DOT's own National Address Database
  county-participation status rather than assumed.
- Exact-match path tries a real point before ever falling back to
  interpolation; every response reports which path was actually used.
- Shipped 2026-08-03. **New Hampshire has no equivalent open dataset**
  (confirmed directly, including checking whether individual
  municipalities publish their own — a few do, e.g. Keene, but not
  enough to substitute for one statewide source) — tracked as the one
  open item at the bottom of this plan.

## Phase 6 — Batch tooling and self-serve growth

**Goal:** make the free entry points (single lookup, reverse geocode)
and the paid one (batch) easier to actually use with real, messy data —
not just API-shaped input.

- `POST /places/search`: search for a category of place near an
  address/area, export the matches as a ready-to-geocode list. Shipped
  Overpass-only first (2026-08-08), then redesigned Nominatim-first
  with Overpass as fallback (2026-08-09) after live-testing both
  approaches' actual reliability under load — not just adding a longer
  timeout to the original design.
- Import Addresses: a CSV/Excel wizard (SheetJS) that maps messy,
  multi-column exports into a clean address list, with per-column
  filters, bulk selection, and a direct handoff into Batch — ported to
  mobile the same week it shipped on desktop.
- Manual coordinate entry for reverse geocoding (not map-click-only).
- ID/primary-key column tracking: a mapped ID column rides through
  Import → Batch and comes back out in the final results file, so a
  customer's own records line up with the output without a manual join
  step afterward.
- Shipped 2026-08-08 through 2026-08-10.

## Phase 7 — Hardening and polish

**Goal:** close real gaps found by direct testing and review — both
security and product — rather than only adding features.

- **Security:** an unauthenticated request could trigger a batch
  endpoint to read an arbitrary file off the server's disk (`.env`
  secrets, a customer-database backup) before quota/auth ever ran,
  found and confirmed live against production-adjacent data, then
  closed by sandboxing the batch `filePath` option to the same
  directory every legitimate caller already used.
- **Correctness:** a duplicate-vertex edge case in the interpolation
  walk (both JS and Python) could snap early to the wrong point; the
  E911 exact-match path could return a confident match under a
  caller-supplied ZIP it had never actually checked.
- **Product:** a real homepage pitch (headline, differentiators, a
  pricing teaser) in place of a plain task-box dashboard; a working
  mobile-width nav on desktop and a scrollable tab bar on the native
  app, both of which previously overflowed or overlapped at real phone
  widths; a batch-page dev-only file-path field visually de-emphasized
  relative to the actual primary action.
- Shipped 2026-08-11 through 2026-08-13.

## Open / not yet built

Tracked here rather than left implicit:

- **New Hampshire accuracy upgrade** — blocked on data availability, not
  engineering; the state's real address-point data sits with its
  Dept. of Safety and isn't published openly. Currently marked
  in-progress on the public timeline as the one thing genuinely still
  pending.
- **Bounded concurrency for batch geocoding** — currently strictly
  sequential per address, on purpose (to avoid exhausting the Postgres
  pool); a bounded-concurrency version (e.g. ~8 in flight, under `pg`'s
  default pool size of 10) is planned for a real speedup on large
  batches without that risk.
- **A real batch-results email attachment** — `sendResultsEmail`
  (the ZIP-by-email path) is a deliberate stub; building it needs a raw
  MIME message, not just the plain-text send the service-key email
  already uses.
- **Local-disk-only database backups** — `ops/backup-databases.sh`
  writes to `~/backups/geocoding` today; off-box storage isn't wired up
  yet.
