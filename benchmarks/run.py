"""Runs the geocoding accuracy benchmark and records the results.

    python -m benchmarks.run                       # every available provider
    python -m benchmarks.run --only meridian       # name substring filter
    python -m benchmarks.run --no-record           # print only

For each provider: geocode every address in the fixed sample, measure
the distance from the returned point to the address's true E911
location, then (unless --no-record):
  - append one summary row per provider to benchmarks/RESULTS.md, and
  - write per-address results to benchmarks/runs/<date>_<provider>.csv
    (id, found, error in meters, the service's match type -- never a
    third-party service's coordinates).
"""

import argparse
import csv
import math
import statistics
import subprocess
from datetime import date
from pathlib import Path

from .providers import REPO, all_providers
from .sample import DATA_DIR, read_sample

BENCH_DIR = Path(__file__).parent
RESULTS_MD = BENCH_DIR / "RESULTS.md"
RUNS_DIR = BENCH_DIR / "runs"
DEFAULT_SAMPLE = DATA_DIR / "maine_e911_300.csv"

# Accuracy tiers, in meters from the true E911 point. 50 m is the headline:
# within 50 m is "on the right property" for most Maine lots.
TIERS = (25, 50, 150)
WRONG_PLACE_M = 500


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def score(sample, results) -> tuple[list[dict], dict]:
    """Per-address rows and a summary. Percentages are of ALL sample
    addresses (not found = not accurate); error stats are over found ones."""
    rows = []
    for item in sample:
        result = results.get(item["id"])
        found = bool(result and result.matched and result.lat is not None)
        error = haversine_m(item["true_lat"], item["true_lon"], result.lat, result.lon) if found else None
        rows.append({"id": item["id"], "found": found, "error_m": None if error is None else round(error, 1),
                     "quality": result.quality if result else None})

    n = len(rows)
    errors = sorted(r["error_m"] for r in rows if r["found"])
    summary = {
        "n": n,
        "found": len(errors) / n,
        **{f"within_{t}": sum(e <= t for e in errors) / n for t in TIERS},
        "wrong_place": sum(e > WRONG_PLACE_M for e in errors) / n,
        "median_m": statistics.median(errors) if errors else None,
        "p90_m": errors[int(0.9 * (len(errors) - 1))] if errors else None,
    }
    return rows, summary


def by_quality(rows) -> list[tuple]:
    """Accuracy per the service's own precision label (Google's ROOFTOP /
    RANGE_INTERPOLATED, Esri's PointAddress / StreetAddress, Meridian's
    address_point / interpolation, ...): (label, count, within 50 m,
    median error). Shows whether a service's claimed precision holds up,
    e.g. how often a "ROOFTOP" result really is on the right property."""
    groups = {}
    for row in rows:
        if row["found"]:
            groups.setdefault(row["quality"] or "(none)", []).append(row["error_m"])
    return [
        (label, len(errors), sum(e <= 50 for e in errors) / len(errors), statistics.median(errors))
        for label, errors in sorted(groups.items(), key=lambda kv: -len(kv[1]))
    ]


def git_revision() -> str:
    def run(*args):
        return subprocess.run(["git", *args], capture_output=True, text=True, cwd=REPO).stdout.strip()

    rev = run("rev-parse", "--short", "HEAD")
    return f"{rev}-dirty" if run("status", "--porcelain", "--untracked-files=no") else rev


def pct(x) -> str:
    return f"{x:.1%}"


def meters(x) -> str:
    return "–" if x is None else f"{x:,.0f}"


def results_row(day, revision, sample_name, provider, s) -> str:
    return (
        f"| {day} | {revision} | {sample_name} | {provider.name} | {provider.mode} | {pct(s['found'])} "
        f"| {pct(s['within_25'])} | {pct(s['within_50'])} | {pct(s['within_150'])} | {pct(s['wrong_place'])} "
        f"| {meters(s['median_m'])} | {meters(s['p90_m'])} |"
    )


def write_run_csv(path: Path, rows) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "found", "error_m", "quality"])
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sample", type=Path, default=DEFAULT_SAMPLE)
    parser.add_argument("--only", help="run only providers whose name contains this (case-insensitive)")
    parser.add_argument("--no-record", action="store_true", help="print results without saving them")
    args = parser.parse_args()

    sample = read_sample(args.sample)
    day, revision = date.today().isoformat(), git_revision()
    providers = [p for p in all_providers() if not args.only or args.only.lower() in p.name.lower()]

    lines = []
    for provider in providers:
        if not provider.available():
            print(f"skip  {provider.name}: no API key set")
            continue
        print(f"run   {provider.name} / {provider.mode} ({len(sample)} addresses)")
        results = provider.geocode_all(
            sample, progress=lambda done, total: print(f"\r      {done}/{total}", end="", flush=True)
        )
        print()
        rows, summary = score(sample, results)
        line = results_row(day, revision, args.sample.stem, provider, summary)
        print(line)
        for label, count, within_50, median in by_quality(rows):
            print(f"      {label:<28} {count:>4} results, {within_50:6.1%} within 50 m, median {median:,.0f} m")
        lines.append(line)
        if not args.no_record:
            slug = "".join(c if c.isalnum() else "-" for c in f"{provider.name}-{provider.mode}".lower()).strip("-")
            write_run_csv(RUNS_DIR / f"{day}_{slug}.csv", rows)

    if lines and not args.no_record:
        with RESULTS_MD.open("a") as f:
            f.write("\n".join(lines) + "\n")
        print(f"Appended {len(lines)} rows to {RESULTS_MD}")


if __name__ == "__main__":
    main()
