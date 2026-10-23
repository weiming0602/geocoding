# LLM-Assisted Geocoding Design

## Context

Today, when `geocode()` (`geocoding-server/src/geocode.js`) can't match an
address, it throws a `NotFoundError` and the caller gets a plain 404. There is
no fallback and no disambiguation of any kind — a typo'd street name, a wrong
town, or a missing ZIP just fails outright, even when the "real" address is
obvious to a human and already sitting in Meridian's own TIGER/E911 data a
few characters away from what was typed.

This was first raised by the user at the very start of the session that
produced the [public geocoding API](2026-10-12-public-geocoding-api-design.md)
work, and deliberately deferred as a separate sub-project at the time. That
work has since shipped and deployed to both `geocoding-test` and
`geocoding-prod`. This spec covers the deferred piece: using an LLM to
rescue a geocode attempt that would otherwise fail, when the input is
malformed or incomplete rather than genuinely out of area.

## Goals

- When a forward-geocode attempt fails because the input text is malformed
  (misspelled street, wrong town, missing ZIP) rather than genuinely
  unsupported, use an LLM to identify what the caller most likely meant and
  retry — turning some fraction of today's 404s into real matches.
- Never let the LLM invent an address. It may only select among real
  candidates Meridian's own database already contains, never generate new
  text that gets treated as fact.
- Keep this bounded in cost and blast radius: only for addresses plausibly
  within Meridian's actual coverage area, only for authenticated accounts,
  only for single forward-geocode lookups (not reverse-geocode, not batch).
- Every attempt is logged in a persistent table, so usage and outcomes can
  be reviewed directly (`psql`), not just inferred from aggregate metrics.

## Non-goals

- **Reverse geocoding** (`POST /reverse-geocode`) is explicitly out of
  scope. The premise of this feature — a human typed something malformed
  that an LLM can disambiguate — doesn't apply to coordinate input. If no
  street segment exists near a given lat/lon, there's no ambiguous text to
  fix; the LLM has nothing to contribute.
- **Batch geocoding** (`/geocode/batch` and its two variants) is out of
  scope for this iteration. A batch file can contain thousands of lines;
  letting every failed line silently trigger an LLM call would make cost
  scale with how messy a customer's input file happens to be, and batch
  jobs already run sequentially (one address at a time, see
  `batchGeocode.js`'s own comment on why), so this would also slow batch
  runs down. Revisit as a separate, explicitly-scoped follow-up if the
  single-lookup version proves out.
- **Unauthenticated/free requests** never reach this feature at all (see
  Access gating below) — the free-but-rate-limited `/geocode` path added
  by the public API work is unaffected.
- No new pricing tier or billing changes. This is gated on being an
  authenticated account (any tier), not a specific paid add-on.

## Architecture & data flow

A new module, `geocoding-server/src/llmAssist.js`, sits entirely inside
`geocode()`'s existing failure path. The happy path (a normal match) is
completely unchanged.

```
geocode(db, addressInput, { offsetFeet, llmAssist = false })
  → parseAddress() + normal matching (unchanged)
  → on failure (any of the 3 existing NotFoundError cases):
      1. llmAssist flag is false → throw NotFoundError as today, stop here.
         (Only /geocode's handler ever passes true, and only when
         authenticated -- see Integration point below. batchGeocode.js's
         calls into geocode() never pass this at all.)
      2. coverage check: is this plausibly in Maine or New Hampshire?
         -- not in range → throw NotFoundError, no LLM call, no log row.
      3. query real nearby candidates (see Candidate retrieval below)
         -- zero candidates → throw NotFoundError, no LLM call, no log row.
            (Nothing for the LLM to disambiguate between.)
      4. call the LLM with the original input + the candidate list
      5. LLM picks a candidate, or says "none fit", or the call itself fails
         -- any of those three → throw NotFoundError; log the attempt as
            failed (see Logging below)
         -- picked one → re-run the normal matcher against that candidate's
            real street name/town/ZIP (this is already-real TIGER/E911 data,
            so this step effectively always succeeds in producing
            coordinates); log the attempt as succeeded
      6. return the result with source: "llm_assisted" (see Response shape)
```

## Coverage guardrail

Before any LLM call, a cheap, local check decides whether the input is
plausibly within Meridian's actual coverage area (Maine + New Hampshire):

- If an explicit, recognizable state code/name is present and it is
  **not** ME/NH, reject immediately — no amount of LLM correction turns a
  Texas address into a Maine one.
- If a ZIP is present, check it falls in the ME (039xx–049xx) or NH
  (030xx–038xx) prefix ranges.
- If neither a state nor a usable ZIP is present, fall back to checking
  the parsed town name (if any) against known ME/NH town names already in
  `street_names`/`address_points`.
- If all of the above are inconclusive (e.g. just a bare street name with
  nothing else), treat it as plausibly in-range rather than rejecting —
  false negatives here (skipping a legitimately fixable Maine address)
  cost more than the rare false positive (one wasted LLM call on an
  address that turns out to be elsewhere).

This check is a pure function with no DB/network dependency, run first,
before the (cheap but non-zero) candidate query.

## Access gating

Only authenticated requests (valid `email` + `serviceKey`, the same check
`/geocode` already performs via `checkQuota`) reach step 2 above at all.
Unauthenticated/free requests — including the rate-limited free path added
by the public geocoding API work — always get today's plain `NotFoundError`,
with no coverage check, no candidate query, and no LLM call. This keeps the
feature's cost tied directly to paying/registered accounts, never to
anonymous traffic.

## Candidate retrieval

A new query (in `geocode.js` or a sibling module) using Postgres's `pg_trgm`
trigram similarity (`%`/`similarity()`) against `street_names.fullname`,
scoped to the ZIP/town the input suggests (or a broader radius if the town
itself looks misspelled), returning up to 10 of the closest-spelled real
street names along with their town/ZIP. This is read-only against the
`geocoding` database, consistent with the existing read-only pool
(`createReadOnlyPool`) — no new write path there. Requires the `pg_trgm`
extension (`CREATE EXTENSION IF NOT EXISTS pg_trgm;` on the `geocoding`
database, a one-time manual step, same convention as PostGIS/pgRouting's
own setup documented in `CLAUDE.md`).

## The LLM call

- **Model:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`). This is a
  short, bounded "pick one of ≤10 real options, or say none fit" task, not
  open-ended reasoning — the cheapest capable tier is the right fit.
- **Structured output via forced tool-use**, not free-text parsing: a
  single tool (e.g. `pick_candidate`) with input schema
  `{ pick: "A" | "B" | ... | "none", reason: string }`, keyed to a
  lettered version of the candidate list. The response is always one of
  the exact candidates passed in, or the literal `"none"` — structurally,
  the LLM cannot return anything that wasn't already in the candidate
  list.
- **Prompt:** the original raw address string, a note that this is Maine
  or New Hampshire, and the lettered candidate list (street name, town,
  ZIP for each). Explicit instruction to pick only from the list and say
  "none" if nothing plausibly matches.
- **Failure handling:** any failure at all — timeout, API error, malformed
  or missing tool response — is caught and treated exactly like "none
  fit": falls through to the normal `NotFoundError`, logged as a failed
  attempt. A missing/invalid `ANTHROPIC_API_KEY` or an Anthropic outage
  degrades back to today's behavior, never crashes a request.
- **New env var:** `ANTHROPIC_API_KEY`, optional. Unset means the whole
  feature is silently disabled — the coverage/auth checks still run (so
  behavior is otherwise unchanged), but step 4 is skipped straight to the
  normal 404. Same convention as `HERE_API_KEY`/`RESEND_API_KEY`.

## Response shape

On a successful LLM-assisted match, the response has the same shape as any
other `geocode()` result, with:

- `source`: gains a new possible value, `"llm_assisted"`, alongside
  today's `"address_point"`/`"interpolation"` — reuses the existing
  discriminator field rather than adding a parallel one.
- `originalInput`: the raw address string exactly as given (not the
  parsed/normalized form — the LLM may have corrected something
  `parseAddress` itself couldn't even parse).
- `correctedAddress`: the human-readable string of what it was normalized
  to (the picked candidate's real street/town/ZIP), so a caller can see at
  a glance that this was a guess and what the guess actually was, without
  needing a special-cased response schema.

This matters most for a caller like Road Alerts, which feeds geocoded
results into live positioning — the flag lets a consumer choose to treat
an LLM-assisted match with less confidence than a direct database hit,
rather than silently blending the two.

## Logging

A new table in `geocoding_users`, following the same `ensureXTable(pool)`
idempotent-creation pattern as `geocode_rate_limits`/`transactions`/
`feedback`:

```sql
CREATE TABLE IF NOT EXISTS llm_geocode_assists (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  original_input TEXT NOT NULL,
  candidates_considered JSONB NOT NULL,
  picked TEXT,              -- the candidate's normalized street/town/zip, or NULL
  succeeded BOOLEAN NOT NULL,
  failure_reason TEXT,      -- 'none_fit' | 'llm_error' | NULL on success
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

One row per attempt that actually reaches step 4 (passed the coverage
check, was authenticated, and had at least one real candidate) — win or
lose. Out-of-range, unauthenticated, or zero-candidate cases never reach
this table at all, since they never reach the LLM either; this is a log of
this feature's own activity, not a general failed-geocode log. No
dedicated listing/review endpoint — reviewed manually via `psql`, same
convention as `feedback`'s table.

## Integration point

`geocode()` gains a new option: `{ offsetFeet, llmAssist = false }`,
defaulting to off. Only `server.js`'s `/geocode` handler ever passes
`llmAssist: true`, and only when the request is authenticated.
`batchGeocode.js`'s calls into `geocode()` are untouched — it's not a flag
batch has to remember to leave off; it simply never passes it, so batch
behavior cannot drift into this path by accident even as the codebase
evolves.

## Testing strategy

- The Anthropic API call itself is mocked/stubbed in tests — no real API
  calls in the suite, consistent with how Nominatim/Overpass/HERE are
  already handled. Fixtures drive the "picks a candidate," "says none
  fit," and "API errors" paths independently.
- The coverage-check function is pure and gets direct unit tests (ME/NH
  ZIP ranges, explicit other-state rejection, inconclusive-input
  fallthrough).
- The candidate-retrieval query gets real DB-backed tests (seeded
  misspelled-street fixtures), same throwaway-database-per-test pattern as
  the rest of the suite.
- An end-to-end test on `/geocode` itself, with the LLM call stubbed,
  confirms the full flow: malformed input in, `source: "llm_assisted"`
  response out, a row landed in `llm_geocode_assists`.
- A regression test confirms `batchGeocode.js`'s address-list path never
  triggers an LLM call under any circumstance (asserts the mock is never
  invoked during a batch run with deliberately malformed addresses).

## Open questions for the implementation plan

- Exact trigram similarity threshold for the candidate query (how
  "close" a spelling counts as a candidate worth offering the LLM) —
  needs empirical tuning once real misspelled-address examples are
  available; the plan should pick a starting threshold and note it's
  adjustable.
- Whether `pg_trgm`'s one-time `CREATE EXTENSION` step needs to happen on
  `geocoding-test` and `geocoding-prod` as part of this feature's own
  rollout checklist (same manual one-time pattern as PostGIS/pgRouting) —
  yes, and the plan's final-verification section should say so explicitly.
