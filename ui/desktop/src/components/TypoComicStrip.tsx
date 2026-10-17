import type { ReactNode } from 'react';

// A tiny two-panel comic strip -- bordered square panels, like a real
// newspaper strip, starring a cute pin-shaped mascot (same teardrop
// silhouette as the app's own 'geocode' icon, just given a face) rather
// than flat stock-illustration people. Big round eyes + a highlight dot
// in each eye is the classic "cute" cue (same trick most mascot
// characters use); the body shape stays identical panel to panel, only
// the face changes, the way a real strip reuses its cast.
const INK = 'var(--color-accent-800, #5a3b0a)';
const BODY_FILL = 'var(--color-accent-100)';
const PANEL_BG = 'var(--color-surface)';
const PANEL_BORDER = 'var(--color-accent-800, #5a3b0a)';

function Pal({ mood }: { mood: 'confused' | 'happy' }) {
  return (
    <g>
      {/* body: the same pin silhouette as icons.tsx's 'geocode' icon, scaled up */}
      <path
        d="M60 95S25 59.75 25 37.5A35 35 0 0 1 95 37.5C95 59.75 60 95 60 95Z"
        fill={BODY_FILL}
        stroke={INK}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* big round eyes with a highlight dot -- the cute cue */}
      <circle cx="47" cy="40" r="8" fill="#fff" stroke={INK} strokeWidth="2" />
      <circle cx="73" cy="40" r="8" fill="#fff" stroke={INK} strokeWidth="2" />
      {mood === 'confused' ? (
        <>
          <circle cx="49" cy="43" r="3.4" fill={INK} />
          <circle cx="70" cy="37" r="3.4" fill={INK} />
          <circle cx="50.3" cy="41.7" r="1.1" fill="#fff" />
          <circle cx="71.3" cy="35.7" r="1.1" fill="#fff" />
          {/* one eyebrow up, one flat -- "huh?" */}
          <path d="M40 28 L52 25" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          <path d="M66 26 L78 28" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          <path d="M50 58 Q60 55 70 58" fill="none" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="48" cy="40" r="3.4" fill={INK} />
          <circle cx="72" cy="40" r="3.4" fill={INK} />
          <circle cx="49.3" cy="38.7" r="1.1" fill="#fff" />
          <circle cx="73.3" cy="38.7" r="1.1" fill="#fff" />
          <path d="M41 27 L52 26" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          <path d="M68 26 L79 27" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          {/* big open smile */}
          <path d="M45 55 Q60 72 75 55" fill="none" stroke={INK} strokeWidth="2.8" strokeLinecap="round" />
          {/* rosy cheeks */}
          <circle cx="38" cy="50" r="4" fill="var(--color-accent-300)" opacity="0.7" />
          <circle cx="82" cy="50" r="4" fill="var(--color-accent-300)" opacity="0.7" />
        </>
      )}
    </g>
  );
}

function Panel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg viewBox="0 0 160 160" width="100%" style={{ maxWidth: 220, display: 'block' }} role="img" aria-label={label}>
        <rect x="4" y="4" width="152" height="152" rx="10" fill={PANEL_BG} stroke={PANEL_BORDER} strokeWidth="3" />
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
        <g transform="translate(5, 30)">
          <Pal mood="confused" />
        </g>
        {/* speech bubble with the misspelling, red squiggly-underlined like a spellcheck flag */}
        <path
          d="M98 20 h48 a6 6 0 0 1 6 6 v22 a6 6 0 0 1 -6 6 h-18 l-8 10 l2 -10 h-24 a6 6 0 0 1 -6 -6 v-22 a6 6 0 0 1 6 -6 Z"
          fill="#fff"
          stroke={INK}
          strokeWidth="2.2"
        />
        <text x="122" y="38" textAnchor="middle" style={{ fontSize: 11, fontFamily: 'var(--font-body)', fill: INK }}>
          Peqwket
        </text>
        <path d="M106 42 q4 3 8 0 q4 3 8 0 q4 3 8 0 q4 3 8 0" fill="none" stroke="#c0392b" strokeWidth="1.6" />
      </Panel>

      <span aria-hidden="true" style={{ fontSize: 28, color: 'var(--color-accent)', flexShrink: 0 }}>
        →
      </span>

      <Panel label='Found "Pequawket Trl" ✓'>
        <g transform="translate(5, 30)">
          <Pal mood="happy" />
        </g>
        {/* small dropped pin with a checkmark, same spot the speech bubble was */}
        <path
          d="M126 32 c0 13 -14 24 -14 24 s-14 -11 -14 -24 a14 14 0 0 1 28 0 Z"
          fill="var(--color-accent-100)"
          stroke={INK}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M106 32 l4.5 4.5 l8 -9" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </Panel>
    </div>
  );
}
