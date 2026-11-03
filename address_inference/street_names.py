"""Canonical street names, so E911-style and TIGER-style names compare equal.

Maine's E911 spells names out NENA-style ("SOUTH FREEPORT ROAD", "US ROUTE
ONE"); TIGER abbreviates USPS-style ("S Freeport Rd", "US Hwy 1"). Both
sides go through canonical() and are compared on the result. Because both
sides are normalized the same way, over-normalizing (e.g. "NORTH" ->
"N" or "POINT" -> "PT" even when it's part of a name) is harmless: it
happens to both.

Only abbreviations TIGER actually uses are mapped: e.g. TIGER writes
"Pt", "Rdg", "Cv" but spells out "Hill", "Hollow", "Meadow" (counted in
Maine's street_names, 2026-11-02), so HILL is left alone.

Mirrors geocoding-server/src/streetSuffixes.js in spirit, but broader;
that file is the server's (narrower) runtime version and isn't changed.
"""

import re

SUFFIXES = {
    "ALLEY": "ALY",
    "AVENUE": "AVE",
    "BOULEVARD": "BLVD",
    "BYPASS": "BYP",
    "CIRCLE": "CIR",
    "COURT": "CT",
    "COVE": "CV",
    "CROSSING": "XING",
    "DRIVE": "DR",
    "EXTENDED": "EXD",
    "EXTENSION": "EXT",
    "HEIGHTS": "HTS",
    "HIGHWAY": "HWY",
    "LANDING": "LNDG",
    "LANE": "LN",
    "PARKWAY": "PKWY",
    "PLACE": "PL",
    "PLAZA": "PLZ",
    "POINT": "PT",
    "POINTE": "PT",
    "RIDGE": "RDG",
    "SAINT": "ST",  # E911 "SAINT JOHN STREET" vs TIGER "St John St"
    "ROAD": "RD",
    "SQUARE": "SQ",
    "STREET": "ST",
    "TERRACE": "TER",
    "TRAIL": "TRL",
}

DIRECTIONALS = {
    "NORTH": "N",
    "SOUTH": "S",
    "EAST": "E",
    "WEST": "W",
    "NORTHEAST": "NE",
    "NORTHWEST": "NW",
    "SOUTHEAST": "SE",
    "SOUTHWEST": "SW",
}

NUMBER_WORDS = {
    "ONE": "1", "TWO": "2", "THREE": "3", "FOUR": "4", "FIVE": "5",
    "SIX": "6", "SEVEN": "7", "EIGHT": "8", "NINE": "9", "TEN": "10",
}

# "US ROUTE 1", "US HWY 1", "STATE ROUTE 136", "STATE RTE 136", "ROUTE 1",
# "STATE HIGHWAY 3", "ME RTE 9" -> "RTE <n>". The US/State qualifier is
# dropped: E911 often writes "ROUTE 1" for US 1, and the spatial check in
# street_match.py keeps a US and a State route of the same number apart.
ROUTE_RE = re.compile(r"^(?:(?:US|U S|STATE|ST|ME|NH|CO|COUNTY)\s+)?(?:ROUTE|RTE|RT|HWY|HIGHWAY)\s+(\d+[A-Z]?)\b(.*)$")
INTERSTATE_RE = re.compile(r"^(?:INTERSTATE|I)\s*-?\s*(\d+)\b(.*)$")


def canonical(name: str | None) -> str:
    """Canonical form of a street name, e.g. "South Freeport Road" ->
    "S FREEPORT RD", "US ROUTE ONE" -> "RTE 1", "I- 95" -> "I 95"."""
    if not name:
        return ""
    text = name.upper().replace(".", "").replace("'", "").replace("-", " ").replace(",", " ")
    tokens = text.split()

    # Number words only where they're a route number ("ROUTE ONE"), not
    # anywhere ("ONE ROD ROAD" stays as is).
    for i in range(1, len(tokens)):
        if tokens[i] in NUMBER_WORDS and tokens[i - 1] in ("ROUTE", "RTE", "RT", "HWY", "HIGHWAY"):
            tokens[i] = NUMBER_WORDS[tokens[i]]

    tokens = [DIRECTIONALS.get(t, t) for t in tokens]

    # TIGER abbreviates these words wherever they appear ("Mast Lndg Rd"),
    # not just as the final suffix, so every token is mapped; "ROUTE <n>"
    # inside a longer name ("OLD ROUTE 1") becomes "RTE <n>" the same way.
    for i, token in enumerate(tokens):
        if token in ("ROUTE", "RT", "HIGHWAY", "HWY") and i + 1 < len(tokens) and re.fullmatch(r"\d+[A-Z]?", tokens[i + 1]):
            tokens[i] = "RTE"
        else:
            tokens[i] = SUFFIXES.get(token, token)

    text = " ".join(tokens)
    match = INTERSTATE_RE.match(text)
    if match:
        return f"I {match.group(1)}{match.group(2)}".strip()
    match = ROUTE_RE.match(text)
    if match:
        return f"RTE {match.group(1)}{match.group(2)}".strip()
    return text


# Words that name a road's type rather than the road itself: dropped by
# base_name() so "ROOS HILL DR" and "ROOS HILL RD" compare equal, and so
# do "SOMERSET CONDOS" and TIGER's bare "Somerset". Includes words E911
# uses as a suffix that TIGER doesn't (CONDOS, ESTATES).
TYPE_WORDS = set(SUFFIXES.values()) | {"WAY", "RUN", "CONDOS", "CONDOMINIUMS", "ESTATES", "ESTS", "PVT", "EXN"}


def base_name(canonical_name: str) -> str:
    """A canonical name without its trailing road-type word (and a
    directional after it), e.g. "ROOS HILL RD" -> "ROOS HILL",
    "MAIN ST S" -> "MAIN". Returns "" when nothing would be left, so a
    bare type word never matches everything."""
    tokens = canonical_name.split()
    if len(tokens) >= 2 and tokens[-1] in DIRECTIONALS.values():
        tokens = tokens[:-1]
    while len(tokens) >= 2 and tokens[-1] in TYPE_WORDS:
        tokens = tokens[:-1]
    if len(tokens) == 1 and tokens[0] in TYPE_WORDS:
        return ""
    return " ".join(tokens)
