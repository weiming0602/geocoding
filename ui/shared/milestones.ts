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
    date: 'Coming soon',
    title: 'New Hampshire accuracy upgrade',
    description: 'The same real per-house location data, for New Hampshire.',
    current: true,
  },
];
