# Road alerts — mobile-only design (proposal)

> Unlike the other docs in this folder, this describes something **not yet
> built** — a concept worked out in conversation, written up here so it
> doesn't just live in chat history. Scoped to `ui/mobile` only: this is a
> driving-context feature, relevant only while the app is being used on the
> road, so it has no desktop counterpart in `ui/desktop`.

## One paragraph

While driving, the app quietly learns which streets a user actually
travels on a regular basis — not their full trip history, and never their
raw GPS trace — by keeping a small, weighted, per-user subset of the
existing `streets` segments already in the geocoding database. In real
time, it checks that routine set against live hazard, weather, and public
event data, and gives the driver a heads-up before they reach something
relevant — a couple of minutes ahead, direction-aware, so it's telling
them about what's actually in front of them, not behind them or on a
parallel road.

## Why this fits here, not as a separate product

The whole mechanism leans on infrastructure this project already has:
the `streets` table's segment geometry and `tlid` identifiers (see
[DATA_MODEL.md](DATA_MODEL.md)) become the vocabulary a personal route is
described in, and the "fun to know" content type overlaps directly with
the existing Find Places feature (nearby points of interest). Nothing
about hazard/weather/event awareness needs a new street network — it
needs a new *layer* on top of the one that's already there.

## Privacy model

**Revised 2026-09-03: weighted points are stored server-side, in
`geocoding_users`, not on-device.** The original design below called for on-device-only storage
specifically because a person's *routine sequence* of segments (home →
... → work) is close to as re-identifying as raw coordinates. The
decision to move server-side rests on deliberately excluding exactly
that identifying part: a weighted point is only ever a location driven
*through* repeatedly — often literally unremarkable, "the middle of
nowhere, but iterated often" — never a trip's start or end. Recording an
`isEndpoint` ping is a no-op (see `weightedPoints.js`) specifically so a
destination (home, work, a specific store) never becomes a stored point,
however often it's visited. That exclusion is what makes server-side
storage acceptable here; it would not make the *original* home→work
sequence problem go away on its own.

The core design decision remains: **store which streets a user drives
routinely, not where they've been, when, or where they started/ended.**

- No raw trip trace is retained, and no destination (a session's first or
  last ping) is ever recorded — only points strictly between them.
- A point's weight is **recency-weighted, not a flat lifetime count** —
  old driving patterns fade out (e.g. a former commute) rather than
  staying "routine" forever just because it once was. Implemented as an
  exponential decay applied at *read* time (`getWeightedPoints`), not a
  periodic rewrite of stored rows.
- **Cadence: continuous, not batch.** The original design called for a
  batch recompute every 3-4 months rather than a live per-trip update.
  The shipped implementation instead updates a point's weight on every
  matching ping, immediately. This is a real, deliberate deviation from
  the original plan, made for simplicity (no separate scheduled job,
  no distinction between "recorded" and "not yet reflected" data) — worth
  revisiting if per-ping writes ever become a real cost at scale, but not
  a concern at current usage.
- Points are persisted starting from their very first ping (weight 1),
  not held back until they cross a threshold — unlike the original design
  ("only segments whose weight crosses a threshold are persisted at all").
  A one-off visit still creates a row; it just decays away (and stays
  below `roadAlertsMatching.ts`'s `minWeight` threshold for alerting)
  rather than never having been written. Simpler to reason about, at the
  cost of some low-weight noise sitting in the table.
- Storage is by raw coordinate (`latitude`/`longitude`) with an optional
  `tlid`, matching the existing `WeightedPoint` shape `roadAlertsMatching.ts`
  already expects — not a `tlid`-only segment model as sketched below.
- Outbound network calls for hazard data are **anonymous by construction**
  — "what's in this bounding box right now" reveals nothing about a
  specific user, since it's the same query shape regardless of who's
  asking.

### User-facing setting: how much routine is remembered

Exposed as a single choice, not a raw "weight threshold" (users don't
need to know the underlying mechanic):

| Setting | Behavior |
| --- | --- |
| **Minimal** | Only streets driven almost every time are remembered. Fewest streets stored, strongest privacy — may miss alerts on routes driven less often. |
| **Balanced** *(default)* | Streets driven regularly, not just constantly. |
| **Most complete** | Includes streets driven only occasionally. Most complete alert coverage, at the cost of remembering more of the user's driving habits. |

In-app copy already drafted for this (see the "How road alerts work"
explainer + table from the design conversation) — reuse verbatim when
this gets built rather than rewriting.

## Content model: type × severity

Two independent dimensions. **Type** is the data source; **severity** is
how urgently it's delivered. Any type can appear at any severity — a
public event is usually "fun to know," but a large one causing a road
closure is "need to know" or "serious," same as a large traffic incident.

### Types

| Type | Source | Real-time or static? |
| --- | --- | --- |
| **Traffic hazard** | New England 511 (see below) | Real-time |
| **Weather** | NOAA/National Weather Service public alerts API | Real-time |
| **Public event** | Municipal event/assembly permits (parades, rallies, demonstrations) | Semi-static (dated, but not continuously updated like traffic) |
| *(static road features)* | Not yet sourced — see Open questions | Static |

### Severity tiers

| Tier | Delivery | Examples |
| --- | --- | --- |
| **Serious** | Spoken automatically + sound/vibration, possible reroute suggestion | Major accident, road closed ahead, severe weather warning, state of emergency |
| **Something need to know** | Spoken automatically, no alarm | Meaningful traffic delay, construction, weather advisory |
| **Not serious, proximity-triggered** | Spoken, brief, lower urgency in tone | Speed camera, toll, school zone, sharp curve, low bridge |
| **Fun to know** | Never interrupts, never spoken automatically — visual only, or spoken on request | Historical marker, local landmark — overlaps with existing Find Places data |

Default bias for uncertain cases (e.g. a driver *might* turn off before
reaching a hazard): **alert anyway.** A missed real hazard costs more
than an unnecessary one. Watch for alert fatigue once there's real usage
data to tune against — not a reason to change the default now, just
something to monitor once this ships.

## Delivery channels

**Voice is the primary channel, not visual text — on purpose.** The
whole point of this feature is surfacing things a driver can't safely
stop and read; a text notification just relocates that same problem
onto a phone screen. `expo-speech` (on-device text-to-speech, works
offline, no new backend dependency) speaks serious/need-to-know/
proximity tiers automatically; screen content is a secondary, glanceable
backup, not the primary delivery method. "Fun to know" stays visual-only
by default, consistent with never interrupting — spoken only if the
user actively asks for it.

Three things to settle before this is real, not just conceptual:

- **Queueing.** Two alerts landing close together need to speak in
  order, not overlap.
- **Ducking vs. interrupting.** If music or a podcast is already
  playing, does the alert lower that audio and speak over it (more
  polished, more work) or just interrupt outright (simpler)?
- **A mute/visual-only toggle.** Voice should be the default, not the
  only option — some users will still want it silent.

### User-facing setting: how much detail is spoken

A separate axis from severity — severity decides *whether* something is
spoken at all; this decides *how much* gets said once it is. Same
three-level pattern as the privacy setting above, for consistency:

| Setting | Behavior |
| --- | --- |
| **Brief** | A short phrase — what and roughly where. "Accident ahead on Main." Fastest to listen to, least detail. |
| **Average** *(default)* | A sentence or two — adds distance/lane/expected delay where the source data has it. "Accident ahead on Main, right lane blocked, expect delays." |
| **Deep** | Full available detail, spoken as a short paragraph — everything the source data carries (cause, all affected lanes, alternate-route suggestion, timing). Takes longest to listen to; best suited to "serious" tier where the extra detail is worth the time, less so for brief proximity alerts. |

This applies per-utterance, not per-tier — the same setting governs how
verbose a "serious" alert and a "fun to know" item are, so a driver who
wants brevity gets it everywhere, not just on the urgent ones. Content
length is naturally capped by what the source data actually contains —
`road_signals.description` (see Data model sketch below) would need to
carry both a short and a long form, not just one string, for this to
work without re-summarizing at speak-time.

**Email is a secondary, non-real-time channel, opt-in.** It doesn't fit
serious/need-to-know alerts at all — by the time an email is read, the
driver has already passed the point, so it would never replace voice
for anything urgent. Where it does fit: an opt-in trip digest (what
fired during a drive, useful as a record or for reviewing "fun to know"
items at leisure rather than while driving), or a fallback log of what
was surfaced. This reuses infrastructure that already exists rather
than needing anything new — `geocoding-server/src/emailDelivery.js`'s
Resend setup (currently used for the service-key purchase email) is
the same mechanism this would ride on.

## Real-time matching

1. Read live position **and heading** (`expo-location` already provides
   both — same field noted when this conversation started, re: detecting
   coordinates while driving).
2. From the current position, do a short graph search **within the
   user's stored routine segments only**, in the direction of travel —
   "which of my usual streets are reachable in the next few minutes
   going this way."
3. Cross-reference that reachable set against live hazard/weather/event
   data for anything on or near those segments.
4. Alert according to the matched item's severity tier.

This is why direction matters: `streets` segments are undirected in the
data itself, so without heading, a hazard "on" a segment can't be told
apart from being ahead of or behind the driver.

## New England 511 — confirmed access

Checked directly against the source, not assumed:

- Portal: `nec-por.ne-compass.com/DeveloperPortal`. Covers Maine, New
  Hampshire, and Vermont: incidents, traffic conditions, travel times,
  lane closures, DMS messages, CCTV status, and Waze-sourced incident
  data (via MaineDOT/NHDOT/VTrans's Waze for Cities partnership).
- **No registration, login, or API key required** — data links sit
  directly on the portal behind a click-through terms agreement.
- **Commercial use is explicitly permitted** ("profitable projects are
  acceptable," per their own stated principles).
- Obligations: clearly attribute the data source, never claim ownership
  of the data, never imply affiliation with the state agencies. Provided
  as-is with no accuracy/uptime warranty — matters for anything used in a
  safety-relevant alert. Expect the data/format to change without notice
  (their own stated expectation, not a hypothetical).
- The Waze-sourced portion specifically may carry its own separate
  restrictions under Waze's Connected Citizens Program — worth a closer
  read of the terms before depending on it, versus the DOT-native
  incident data.

## Data model sketch

Informal, matching the existing convention of no DB-enforced foreign
keys (see [DATA_MODEL.md](DATA_MODEL.md)) — matched by shared identifier,
not a schema-level constraint.

**`road_alerts_weighted_points`** (as shipped, in `geocoding_users` — see
"Revised" note under Privacy model above; supersedes this section's
originally-sketched on-device `user_routine_segments`) — the per-user
weighted set. `email`, `latitude`, `longitude`, `weight`, `tlid`
(optional, references `streets.tlid` when known), `last_pinged_at`.

**`road_signals`** — the hazard/weather/event content itself.
`id`, `type` (`traffic_hazard` / `weather` / `public_event` / ...),
`severity` (`serious` / `need_to_know` / `proximity` / `fun_to_know`),
`geometry`, `direction` (if relevant), `valid_from`, `valid_until`,
`source`, `description` (kept short enough to speak aloud directly).

Delivery preferences live on the existing account, not a new table —
`geocoding_users.users` (see [DATA_MODEL.md](DATA_MODEL.md)) already
carries `email`; this would just add per-user voice/mute and
email-digest opt-in flags alongside it.

## Open questions (not yet resolved)

- Exact weight *threshold* for "high enough to keep" — the recompute
  **cadence** is settled (~every 3–4 months, see Privacy model above),
  but the cutoff value itself (a minimum count, a percentile, a
  fixed-window rule) is still undecided.
- Where "static road features" (speed cameras, school zones, low
  bridges) actually come from — a new curated dataset, OpenStreetMap/
  Overpass tags (already integrated for Find Places), or something else.
- New England 511's exact response format/schema per data type — access
  is confirmed open, but the JSON/XML shape hasn't been reviewed yet.
- NOAA weather alerts API integration specifics — not yet looked into
  beyond "it's free, public, and exists."
- The on-device route-learning/map-matching algorithm itself — described
  conceptually here, not designed in implementation detail.
- Voice queueing and ducking-vs-interrupting behavior when alerts land
  close together or other audio is already playing.
- Email digest cadence and format (per trip, daily, weekly) — the
  channel and its reuse of existing SES infrastructure are settled, the
  actual schedule isn't.

**Deliberately deferred, not urgent:** a concrete Maine/NH source for
municipal event permits. The pattern (cities publishing permits as open
data) is real elsewhere, but no specific local source has been checked
for this region yet — fine to leave for later, doesn't block anything
else in this design.
