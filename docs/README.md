# Reference documentation

Reverse-engineered from the codebase as it exists (August 2026) — these
describe the system that was actually built, not a forward-looking
proposal. For setup/run instructions see the root
[README.md](../README.md); for agent-facing conventions and known gaps
see the root [CLAUDE.md](../CLAUDE.md); for data provenance/licensing
see [DATA_SOURCES.md](../DATA_SOURCES.md).

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — components, request flow,
  databases, deployment, and the reasoning behind the bigger structural
  decisions.
- **[DATA_MODEL.md](DATA_MODEL.md)** — every table, column, and index,
  and why each exists.
- **[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)** — the "Classical" design
  system's tokens and component vocabulary, and where desktop/mobile
  deliberately diverge instead of chasing pixel parity.
- **[PROJECT_PLAN.md](PROJECT_PLAN.md)** — how the project actually got
  built, phase by phase, plus what's still open.

The one exception to "describes what's built": **[ROAD_ALERTS_DESIGN.md](ROAD_ALERTS_DESIGN.md)**
is a proposal, not yet implemented — a mobile-only driving-alerts
concept (private per-user routine learning + real-time hazard/weather/
event matching) worked out in conversation and written up so it doesn't
just live in chat history.

No source code is reproduced in any of these — they're structural and
narrative descriptions only.
