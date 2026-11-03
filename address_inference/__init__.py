"""Building-based address inference (experiment).

Predicts per-building address locations from building footprints + TIGER
street ranges, trained and scored against real address points (Maine
E911 first). Design: docs/superpowers/specs/2026-11-02-building-address-
inference-design.md.

Kept separate from the `geocoding` package on purpose: nothing here is
used by geocoding-server or the ingest pipeline. Everything it writes
lives in the `address_inference` Postgres schema.
"""
