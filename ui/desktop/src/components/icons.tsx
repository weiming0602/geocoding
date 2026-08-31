import type { SVGProps } from 'react';

// One glyph per nav destination, all sharing the same stroke-based style
// (24x24 viewBox, 1.8 stroke, round caps/joins) so they read as one system --
// see the icon-nav design review for the reasoning behind the shape choices.
export type IconName =
  | 'overview'
  | 'geocode'
  | 'reverseGeocode'
  | 'findPlaces'
  | 'roadAlerts'
  | 'importAddresses'
  | 'batch'
  | 'planQuota'
  | 'pricing'
  | 'progress'
  | 'help';

type IconProps = { name: IconName; size?: number };

const STROKE_PROPS: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export function Icon({ name, size = 20 }: IconProps) {
  const props = { ...STROKE_PROPS, width: size, height: size };
  switch (name) {
    case 'overview':
      return (
        <svg {...props}>
          <path d="M4 11.5 12 4l8 7.5" />
          <path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9" />
        </svg>
      );
    case 'geocode':
      return (
        <svg {...props}>
          <path d="M12 21s7-7.05 7-11.5A7 7 0 0 0 5 9.5C5 13.95 12 21 12 21Z" />
          <circle cx="12" cy="9.5" r="2.4" />
        </svg>
      );
    case 'reverseGeocode':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      );
    case 'findPlaces':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M15.2 8.8 13 13l-4.2 2.2L11 11l4.2-2.2Z" />
        </svg>
      );
    case 'roadAlerts':
      return (
        <svg {...props}>
          <path d="M12 3.5 21 19.5H3L12 3.5Z" />
          <path d="M12 9.5v4.4" />
          <circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'importAddresses':
      return (
        <svg {...props}>
          <path d="M12 3v11" />
          <path d="M8 10.5 12 14.5 16 10.5" />
          <path d="M4.5 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
        </svg>
      );
    case 'batch':
      return (
        <svg {...props}>
          <path d="M12 3 3 8l9 5 9-5-9-5Z" />
          <path d="M3 12l9 5 9-5" />
          <path d="M3 16l9 5 9-5" />
        </svg>
      );
    case 'planQuota':
      return (
        <svg {...props}>
          <path d="M4 15a8 8 0 1 1 16 0" />
          <path d="M12 15 15.5 10" />
          <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'pricing':
      return (
        <svg {...props}>
          <path d="M11.6 3.5H19a1.5 1.5 0 0 1 1.5 1.5v7.4a1.5 1.5 0 0 1-.44 1.06l-8 8a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1 0-2.12l8-8a1.5 1.5 0 0 1 1.06-.44Z" />
          <circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'progress':
      return (
        <svg {...props}>
          <path d="M4 19V10" />
          <path d="M10 19V5" />
          <path d="M16 19v-7" />
          <path d="M4 19h16" />
        </svg>
      );
    case 'help':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.3a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1 .9-1 1.7" />
          <circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

// The three vertical lines (outer edge + two meridians) sit at even
// intervals across the radius -- rx 4.2/8.3 against an r=12.5 circle --
// rather than clustered off to one side, after review feedback.
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="12.5" />
      <ellipse cx="16" cy="16" rx="4.2" ry="12.5" />
      <ellipse cx="16" cy="16" rx="8.3" ry="12.5" />
      <path d="M3.5 16h25" />
    </svg>
  );
}

// A tilted "AI" badge over BrandMark's globe -- used only at the one place
// the logo is actually looked at directly (the nav header; see Layout.tsx's
// nav-brand), not the footer BrandMark or the giant background watermark,
// where any flourish would be pointless/noisy. BrandMark itself stays
// untouched and static (it's also rendered at those quieter sizes) -- this
// wraps it rather than baking the badge into the glyph.
// Static (no animation loop): "AI" leaned over at an angle with three
// trailing speed lines, the classic cartoon shorthand for "running/moving
// fast" (manga speed lines behind a dashing character). AI_BADGE_COLOR is a
// vivid magenta-red deliberately unlike anything else in the palette
// (golden accent, teal accent-2, violet route color) so it reads
// immediately against the globe instead of blending in.
const AI_BADGE_COLOR = '#ff2e6e';
export function BrandMarkOrbit({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-orbit" style={{ width: size, height: size }}>
      <BrandMark size={size} />
      <svg className="brand-orbit__trail" viewBox="0 0 32 32" aria-hidden="true">
        <g transform="rotate(-14 16 16)">
          <line x1={3} y1={10} x2={9} y2={13} stroke={AI_BADGE_COLOR} strokeWidth={1.8} strokeLinecap="round" opacity={0.85} />
          <line x1={1} y1={15} x2={8} y2={17} stroke={AI_BADGE_COLOR} strokeWidth={1.5} strokeLinecap="round" opacity={0.55} />
          <line x1={2} y1={21} x2={8} y2={21} stroke={AI_BADGE_COLOR} strokeWidth={1.2} strokeLinecap="round" opacity={0.3} />
          <text
            x={16}
            y={20.5}
            textAnchor="middle"
            fontSize={13}
            fontWeight={800}
            fill={AI_BADGE_COLOR}
            stroke="#fff8ea"
            strokeWidth={0.6}
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            AI
          </text>
        </g>
      </svg>
    </span>
  );
}
