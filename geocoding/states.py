"""Registry of state FIPS codes and their counties, for update_state.py."""

STATES = {
    "ME": {
        "fips": "23",
        "name": "Maine",
        "counties": {
            "001": "Androscoggin",
            "003": "Aroostook",
            "005": "Cumberland",
            "007": "Franklin",
            "009": "Hancock",
            "011": "Kennebec",
            "013": "Knox",
            "015": "Lincoln",
            "017": "Oxford",
            "019": "Penobscot",
            "021": "Piscataquis",
            "023": "Sagadahoc",
            "025": "Somerset",
            "027": "Waldo",
            "029": "Washington",
            "031": "York",
        },
    },
    "NH": {
        "fips": "33",
        "name": "New Hampshire",
        "counties": {
            "001": "Belknap",
            "003": "Carroll",
            "005": "Cheshire",
            "007": "Coos",
            "009": "Grafton",
            "011": "Hillsborough",
            "013": "Merrimack",
            "015": "Rockingham",
            "017": "Strafford",
            "019": "Sullivan",
        },
    },
}

# Reverse lookup used by ingest.py to fill in streets.state_abbr/state from
# a shapefile row's own STATEFP -- TIGER/Line's edges layer carries no state
# abbreviation or name field, only the numeric FIPS code.
FIPS_TO_ABBR = {state["fips"]: abbr for abbr, state in STATES.items()}
