import type { ReactNode } from 'react';

import DrMeridian from './DrMeridian';

// A tiny two-panel comic strip starring Dr. Meridian -- the brand's own
// globe mark given a body, white coat, and stethoscope, "diagnosing" a
// misspelled street name and then confirming the real one. Bordered
// square panels, like a real newspaper strip, rather than flat
// stock-illustration people.
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
      <Panel label='Dr. Meridian spots "Peqwket Trl"'>
        <g transform="translate(5, 8)">
          <DrMeridian pose="diagnosing" />
        </g>
        {/* chart his pointing hand aims at, with the misspelling */}
        <rect x="118" y="30" width="46" height="30" rx="4" fill="#fff" stroke={INK} strokeWidth="2" />
        <text x="141" y="48" textAnchor="middle" style={{ fontSize: 10, fontFamily: 'var(--font-body)', fill: INK }}>
          Peqwket
        </text>
        <path d="M124 52 q4 2.5 8 0 q4 2.5 8 0 q4 2.5 8 0" fill="none" stroke="#c0392b" strokeWidth="1.4" />
      </Panel>

      <span aria-hidden="true" style={{ fontSize: 28, color: 'var(--color-accent)', flexShrink: 0 }}>
        →
      </span>

      <Panel label='Confirms "Pequawket Trl" ✓'>
        <g transform="translate(5, 8)">
          <DrMeridian pose="pleased" />
        </g>
        {/* small checkmark badge, same spot the chart was */}
        <circle cx="141" cy="45" r="16" fill="var(--color-accent-100)" stroke={INK} strokeWidth="2" />
        <path d="M133 45 l5.5 5.5 l10 -11" fill="none" stroke={INK} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </Panel>
    </div>
  );
}
