import type { ReactNode } from 'react';

import DrMeridian from './DrMeridian';

// A tiny two-panel comic strip. The street name is the thing a visitor
// should actually look at, so it's the large, centered element in each
// panel; Dr. Meridian is a small supporting figure tucked in a corner,
// pointing toward it -- not the focal point himself. (An earlier version
// had him full-size and centered, which drew the eye to the mascot
// instead of the content he's explaining -- fixed per review.)
const INK = 'var(--color-accent-800, #5a3b0a)';
const PANEL_BG = 'var(--color-surface)';
const PANEL_BORDER = 'var(--color-accent-800, #5a3b0a)';

function Panel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg viewBox="0 0 170 170" width="100%" style={{ maxWidth: 220, display: 'block' }} role="img" aria-label={label}>
        <rect x="4" y="4" width="162" height="162" rx="10" fill={PANEL_BG} stroke={PANEL_BORDER} strokeWidth="3" />
        {children}
      </svg>
      <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
        {label}
      </p>
    </div>
  );
}

export default function TypoComicStrip() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        flexWrap: 'wrap',
        margin: 'var(--space-4) 0',
      }}
    >
      <Panel label='You typed "Peqwket Trl"'>
        {/* the street name -- large, centered, the actual point of the panel */}
        <rect x="18" y="24" width="134" height="60" rx="8" fill="#fff" stroke={INK} strokeWidth="2.4" />
        <text x="85" y="58" textAnchor="middle" style={{ fontSize: 19, fontWeight: 700, fontFamily: 'var(--font-body)', fill: INK }}>
          Peqwket Trl
        </text>
        <path d="M45 66 q6 3 12 0 q6 3 12 0 q6 3 12 0 q6 3 12 0 q6 3 12 0" fill="none" stroke="#c0392b" strokeWidth="2" />

        {/* Dr. Meridian, small, tucked in the corner, whole body leaning
            toward the sign (not just the arm reaching over) -- rotated
            around his own feet so it reads as leaning in, not falling over */}
        <g transform="translate(-2, 94) scale(0.42) rotate(16, 60, 150)">
          <DrMeridian pose="diagnosing" />
        </g>
      </Panel>

      <span aria-hidden="true" style={{ fontSize: 28, color: 'var(--color-accent)', flexShrink: 0 }}>
        →
      </span>

      <Panel label='Found "Pequawket Trl" ✓'>
        <rect x="18" y="24" width="134" height="60" rx="8" fill="#fff" stroke={INK} strokeWidth="2.4" />
        <text x="85" y="58" textAnchor="middle" style={{ fontSize: 19, fontWeight: 700, fontFamily: 'var(--font-body)', fill: INK }}>
          Pequawket Trl
        </text>
        <path
          d="M68 66 l6 6 l12 -13"
          fill="none"
          stroke="var(--color-accent-2, #3a7d68)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <g transform="translate(-2, 94) scale(0.42) rotate(16, 60, 150)">
          <DrMeridian pose="pleased" />
        </g>
      </Panel>
    </div>
  );
}
