// Public progress timeline -- a small, honest record of real milestones,
// meant to show the business is actively being built, not a finished
// (or abandoned) thing. Dates are real (from the project's own commit
// history); wording is customer-facing, not a changelog of every commit.
// `current: true` marks the one upcoming/in-progress entry; everything
// else already shipped.

export type Milestone = {
  date: string; // e.g. "Jul 29, 2026", or "Coming soon" when current
  title: string;
  description: string;
  current?: boolean;
};

export const MILESTONES: Milestone[] = [
  {
    date: 'Jul 29, 2026',
    title: 'Maine geocoding launches',
    description:
      'Address lookup and batch geocoding, built on Census TIGER/Line street data.',
  },
  {
    date: 'Jul 30, 2026',
    title: 'Reverse geocoding added',
    description: 'Coordinates in, nearest address out.',
  },
  {
    date: 'Aug 1, 2026',
    title: 'Alternate street names matched',
    description:
      "A road known by two names (a numbered route and a local name) now resolves the same way either way.",
  },
  {
    date: 'Aug 2, 2026',
    title: 'Mobile and web apps launch',
    description: 'Self-serve plans and quota tracking, on both phone and desktop.',
  },
  {
    date: 'Aug 3, 2026',
    title: 'Moved to a production-grade database',
    description: 'Built for real concurrent traffic, ahead of expanding beyond Maine and New Hampshire.',
  },
  {
    date: 'Aug 3, 2026',
    title: 'Maine accuracy upgrade',
    description:
      'Real per-house locations, not just estimates, for every matched Maine address.',
  },
  {
    date: 'Aug 8, 2026',
    title: 'Find places near an address',
    description:
      'Search for a kind of place -- a school, a pharmacy, a specific business -- near any address or area, and export the matches as a ready-to-geocode list.',
  },
  {
    date: 'Aug 9, 2026',
    title: 'Import addresses from a CSV or Excel export',
    description:
      "Upload a messy export -- street number, name, city, and ZIP each in their own column -- and get back a clean address list ready for batch geocoding. Works the same on phone and desktop.",
  },
  {
    date: 'Aug 9, 2026',
    title: 'Type in coordinates for reverse geocoding',
    description: 'Look up the address at a latitude/longitude directly, not just by clicking the map.',
  },
  {
    date: 'Aug 10, 2026',
    title: 'Your own record IDs, carried through a batch',
    description:
      "Map a primary-key column when importing addresses, and it rides along to the final results -- no manual matching of rows back to your own records afterward.",
  },
  {
    date: 'Aug 11, 2026',
    title: 'Batch upload security hardening',
    description:
      "Found and closed a gap in how the batch endpoint read server-side files -- it's now restricted to only the files it's meant to read.",
  },
  {
    date: 'Aug 11, 2026',
    title: 'Address-matching accuracy fixes',
    description:
      "Fixed an edge case where certain street shapes could throw off an interpolated point, and tightened the exact-match path so a mismatched ZIP or state can no longer override a real address. Batch result CSVs now also show whether each match was an exact point or an estimate.",
  },
  {
    date: 'Aug 28, 2026',
    title: 'Road Alerts redesigned around what matters most',
    description:
      "Opens straight to nearby hazards -- no setup screens in the way. Settings are tucked behind a single toggle for when you actually want them.",
  },
  {
    date: 'Aug 28, 2026',
    title: 'See hazards and detours on a map',
    description:
      "Each alert now shows an interactive map with the hazard and your position -- and, where a way around it exists, up to three alternate routes to choose from.",
  },
  {
    date: 'Aug 28, 2026',
    title: 'One-tap navigation for a chosen detour',
    description: 'Pick an alternate route and hand it straight to Google Maps for real turn-by-turn navigation.',
  },
  {
    date: 'Aug 28, 2026',
    title: 'Hazard type at a glance',
    description:
      "Construction, accidents, closures, and more now show their own icon in the alert list, sorted with the most recently updated hazard first.",
  },
  {
    date: 'Sep 9, 2026',
    title: 'Hazards near where you live',
    description:
      "A new view shows every current hazard around your home area automatically -- no need to be driving to check what's nearby.",
  },
  {
    date: 'Sep 10, 2026',
    title: 'Road Alerts coverage beyond New England',
    description:
      'Traffic hazards are now available with live coverage well outside Maine, New Hampshire, and Vermont, not just within them.',
  },
  {
    date: 'Sep 13, 2026',
    title: "Road Alerts waits until you're actually driving",
    description:
      "Opening the app while parked no longer shows a hazard list for wherever you happen to be sitting -- alerts only start once you're moving.",
  },
  {
    date: 'Sep 13, 2026',
    title: 'Smarter about which hazards matter to you',
    description:
      "Road Alerts now recognizes when you're heading toward one of your usual routes, and prioritizes hazards actually in your way over ones nearby but unrelated to your trip.",
  },
  {
    date: 'Sep 13, 2026',
    title: 'Faster hazard updates',
    description: 'Road Alerts hazard checks now respond faster and more consistently while driving.',
  },
  {
    date: 'Sep 13, 2026',
    title: 'Geocode a Maine address without its ZIP code',
    description:
      'As long as the street, city, and state are given, an exact address can now be matched even without a ZIP code.',
  },
  {
    date: 'Sep 14, 2026',
    title: 'Spelled-out street suffixes now match',
    description:
      'Typing a street name in full -- "Circle" instead of "Cir", "Trail" instead of "Trl" -- now matches the same address as the abbreviated form.',
  },
  {
    date: 'Sep 14, 2026',
    title: 'Choose how much routine driving Road Alerts remembers',
    description:
      "A new setting lets you control how much of your driving pattern gets remembered -- from bare minimum to most complete -- so you can balance privacy against catching more relevant alerts.",
  },
  {
    date: 'Sep 16, 2026',
    title: 'Serious hazards chime and notify you',
    description:
      "A serious or need-to-know hazard ahead now plays a short chime before it's read aloud, and pops up a notification if Road Alerts isn't the tab you're looking at.",
  },
  {
    date: 'Sep 20, 2026',
    title: 'Find places near where you are',
    description: 'Find Places can now search around your current location with one tap, no map click needed.',
  },
  {
    date: 'Oct 2, 2026',
    title: 'Clearer alerts that name the road',
    description:
      'Spoken alerts and notifications now say which road a hazard is on and which lanes are affected, instead of a bare "Closed".',
  },
  {
    date: 'Oct 2, 2026',
    title: 'Tap an alert to see it on the map',
    description: 'Selecting a hazard in the list brings both it and your own position into view on the map.',
  },
  {
    date: 'Oct 4, 2026',
    title: 'No more alarms for ordinary traffic',
    description:
      "Plain congestion no longer sets off a chime or a notification, even when it's heavy -- those are saved for hazards that actually block or endanger the road.",
  },
  {
    date: 'Oct 15, 2026',
    title: 'Look up addresses without an account',
    description:
      'Single address and reverse lookups are now free to try with no sign-up (with a fair-use rate limit), and a public API reference documents every geocoding endpoint for developers.',
  },
  {
    date: 'Oct 23, 2026',
    title: 'Typos in street names, handled',
    description:
      "For account holders, an address that doesn't match because of a misspelled street or wrong town is now checked against the real streets nearby and resolved to the one you meant -- never to an address that doesn't exist.",
  },
  {
    date: 'Oct 25, 2026',
    title: 'The right side of the street, every time',
    description:
      'Fixed how house numbers are matched to each side of a street: addresses that used to come back "not found" now resolve, and every estimated point lands on the correct side of the road.',
  },
  {
    date: 'Oct 25, 2026',
    title: 'See where a hazard is at a glance',
    description:
      'Every alert now shows a small sketch of your recent route, which way you are heading, and where the hazard is, with the distance to it.',
  },
  {
    date: 'Oct 25, 2026',
    title: 'Detours that work in more places, instantly',
    description:
      'Ways around a hazard now appear in rural areas and for any hazard you are alerted about, not just nearby ones, in a fraction of a second instead of several, and explain why when no detour is possible.',
  },
  {
    date: 'Oct 26, 2026',
    title: 'Detours that follow one-way streets',
    description:
      'Ways around a hazard now respect one-way streets, using OpenStreetMap data, so a suggested route never sends you the wrong way down a street or ramp.',
  },
  {
    date: 'Oct 26, 2026',
    title: 'Detours along the roads you usually drive',
    description:
      'Up to three genuinely different ways around a hazard, with the one along your usual roads offered first.',
  },
  {
    date: 'Oct 27, 2026',
    title: 'Your routine stays private',
    description:
      'Road Alerts no longer keeps points near where your drives start and end, and forgets the rest after 21 days.',
  },
  {
    date: 'Oct 27, 2026',
    title: 'Typos fixed in batch files too',
    description:
      'In a paid batch run, rows with a misspelled street are now matched to the real street you meant and marked as corrected -- never moved to a different town.',
  },
  {
    date: 'Oct 27, 2026',
    title: 'Alerts that get your attention, not your nerves',
    description: 'A serious alert now rings three times, then speaks -- once, however many hazards arrive together.',
  },
  {
    date: 'Coming soon',
    title: 'New Hampshire accuracy upgrade',
    description: 'The same real per-house location data, for New Hampshire.',
    current: true,
  },
];

// MILESTONES itself stays in shipped order (oldest first) so a new entry
// is just appended at the end -- both apps' Progress screens display
// newest first, so this derived, reversed view is what they actually
// render.
export const MILESTONES_NEWEST_FIRST: Milestone[] = [...MILESTONES].reverse();
