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
    date: 'Coming soon',
    title: 'New Hampshire accuracy upgrade',
    description: 'The same real per-house location data, for New Hampshire.',
    current: true,
  },
];
