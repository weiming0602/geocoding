"""Annual maintenance job: refresh every state's TIGER/Line streets and
Maine's E911 address points in one run.

Both underlying steps are insert-only and keyed on a stable ID (TLID for
streets/street_names, SITE_UID for address_points), so re-running this
against data already in the database is safe -- it only picks up rows
that are new since the last run (a new TIGER vintage, or newly added
E911 addresses). Meant to be invoked once a year by cron or a systemd
timer; see ops/ for example unit files.
"""

import argparse
import sys
from datetime import date
from pathlib import Path

from .ingest_address_points import ingest_address_points
from .states import STATES
from .update_state import update_state


def annual_update(dsn: str, year: int, data_dir: Path, *, states=None, skip_address_points=False) -> bool:
    """Runs update_state for each of `states` (default: everything in
    STATES) and, unless skipped, refreshes Maine's E911 address points.
    Returns True if every step succeeded; logs and continues past a
    failed state instead of aborting the whole run, so one state's
    network hiccup doesn't block the others."""
    states = states or sorted(STATES)
    ok = True

    for state_abbr in states:
        print(f"[{date.today()}] updating streets for {state_abbr} (TIGER {year})...")
        try:
            update_state(state_abbr, dsn, year, data_dir / state_abbr.lower())
        except Exception as exc:  # noqa: BLE001 -- one state's failure shouldn't stop the rest
            print(f"[{date.today()}] FAILED updating {state_abbr}: {exc}", file=sys.stderr)
            ok = False

    if not skip_address_points and "ME" in states:
        print(f"[{date.today()}] refreshing Maine E911 address points...")
        try:
            count = ingest_address_points(dsn)
            print(f"[{date.today()}] inserted {count} new address points")
        except Exception as exc:  # noqa: BLE001
            print(f"[{date.today()}] FAILED refreshing address points: {exc}", file=sys.stderr)
            ok = False

    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dsn", help="Postgres connection string, e.g. 'dbname=geocoding'")
    parser.add_argument(
        "--year", type=int, default=date.today().year, help="TIGER/Line vintage year (default: current year)"
    )
    parser.add_argument(
        "--states",
        nargs="+",
        choices=sorted(STATES),
        default=None,
        help="States to update (default: all of geocoding.states.STATES)",
    )
    parser.add_argument(
        "--data-dir", type=Path, default=Path("data"), help="Base directory to cache downloads in (default: data/)"
    )
    parser.add_argument(
        "--skip-address-points", action="store_true", help="Skip the Maine E911 address-point refresh"
    )
    args = parser.parse_args()

    ok = annual_update(
        args.dsn, args.year, args.data_dir, states=args.states, skip_address_points=args.skip_address_points
    )
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
