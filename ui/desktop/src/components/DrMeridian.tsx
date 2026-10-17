// "Dr. Meridian" -- a mascot built directly from the real brand mark
// (icons.tsx's BrandMark: a circle with two meridian-line ellipses and
// an equator line, stroke-only) used as the character's head, so he
// reads as literally "the logo, brought to life" rather than an
// unrelated character. Chibi proportions (big head, short body) both
// keep him readable inside a small square panel and reinforce the cute
// mascot direction already established by the pin character. White
// coat + stethoscope is the whole "doctor" visual shorthand -- no need
// for more detail than that to read clearly at this size.
const INK = 'var(--color-accent-800, #5a3b0a)';
const COAT = '#fdfdfb';

function GlobeHead({ mood }: { mood: 'diagnosing' | 'pleased' }) {
  return (
    <g>
      {/* the real BrandMark geometry, scaled up: circle + meridian ellipses + equator */}
      <circle cx="60" cy="42" r="30" fill="#fff" stroke={INK} strokeWidth="2.6" />
      <ellipse cx="60" cy="42" rx="10" ry="30" fill="none" stroke={INK} strokeWidth="1.6" />
      <ellipse cx="60" cy="42" rx="20" ry="30" fill="none" stroke={INK} strokeWidth="1.6" />
      <path d="M30 42 h60" stroke={INK} strokeWidth="1.6" />
      {/* face, overlaid on the globe -- same big-eye cue as the pin mascot */}
      <circle cx="49" cy="40" r="6.5" fill="#fff" stroke={INK} strokeWidth="1.8" />
      <circle cx="71" cy="40" r="6.5" fill="#fff" stroke={INK} strokeWidth="1.8" />
      {mood === 'diagnosing' ? (
        <>
          <circle cx="51" cy="41" r="2.6" fill={INK} />
          <circle cx="69" cy="41" r="2.6" fill={INK} />
          {/* furrowed, focused brow -- examining, not confused */}
          <path d="M42 30 L54 32" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M66 32 L78 30" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M53 55 Q60 58 67 55" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="50" cy="40" r="2.6" fill={INK} />
          <circle cx="70" cy="40" r="2.6" fill={INK} />
          <path d="M43 31 L54 30" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M66 30 L77 31" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M50 54 Q60 64 70 54" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
        </>
      )}
    </g>
  );
}

export default function DrMeridian({ pose }: { pose: 'diagnosing' | 'pleased' }) {
  return (
    <g>
      {/* legs */}
      <path d="M48 128 L45 148" stroke={INK} strokeWidth="7" strokeLinecap="round" />
      <path d="M72 128 L75 148" stroke={INK} strokeWidth="7" strokeLinecap="round" />
      <ellipse cx="44" cy="151" rx="7" ry="4" fill={INK} />
      <ellipse cx="76" cy="151" rx="7" ry="4" fill={INK} />

      {/* coat body */}
      <path
        d="M42 72 Q60 64 78 72 L82 130 Q60 138 38 130 Z"
        fill={COAT}
        stroke={INK}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* open lapels */}
      <path d="M53 72 L60 90 L50 95" fill="none" stroke={INK} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M67 72 L60 90 L70 95" fill="none" stroke={INK} strokeWidth="1.6" strokeLinecap="round" />
      {/* a button */}
      <circle cx="60" cy="112" r="2" fill={INK} />

      {/* stethoscope -- collar loop down to a chest piece */}
      <path d="M50 74 Q46 82 52 86 Q58 90 60 100" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
      <path d="M70 74 Q74 82 68 86" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="102" r="3.2" fill="#fff" stroke={INK} strokeWidth="1.8" />

      {pose === 'diagnosing' ? (
        <>
          {/* left arm relaxed at side */}
          <path d="M42 78 Q34 95 38 112" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
          {/* right arm extended, pointing */}
          <path d="M78 78 Q96 80 106 68" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
          <circle cx="108" cy="65" r="4" fill={INK} />
        </>
      ) : (
        <>
          {/* both arms relaxed, head tipped pleased (handled by mood) */}
          <path d="M42 78 Q33 92 37 108" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
          <path d="M78 78 Q87 92 83 108" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
        </>
      )}

      <g transform="translate(0, 0)">
        <GlobeHead mood={pose === 'diagnosing' ? 'diagnosing' : 'pleased'} />
      </g>
    </g>
  );
}
