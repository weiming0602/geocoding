// "Dr. Meridian" -- a cute, kindly old-doctor character (round head,
// glasses, a little gray hair and mustache -- the classic "wise family
// doctor" cues) wearing the brand's own globe mark as a chest pin/badge
// on his white coat, rather than wearing it as his actual face (an
// earlier version used the globe geometry as the head itself; it read
// as a mask, not a face -- fixed here per review). Chibi proportions
// (big head, short body) keep him readable inside a small square panel
// and match the cute direction already established by the pin
// character this replaced.
const INK = 'var(--color-accent-800, #5a3b0a)';
const COAT = '#fdfdfb';
const HAIR = '#d8d2c4';

function DoctorHead({ mood }: { mood: 'diagnosing' | 'pleased' }) {
  return (
    <g>
      {/* head */}
      <circle cx="60" cy="42" r="28" fill="#fce8cf" stroke={INK} strokeWidth="2.4" />
      {/* gray hair -- just the sides/back, a little bald on top, "wise elder" cue */}
      <path
        d="M33 38 A28 28 0 0 1 60 15 A28 28 0 0 1 87 38 Q80 26 60 26 Q40 26 33 38 Z"
        fill={HAIR}
        stroke={INK}
        strokeWidth="1.6"
      />
      <path d="M32 40 Q30 52 36 60" fill="none" stroke={HAIR} strokeWidth="6" strokeLinecap="round" />
      <path d="M88 40 Q90 52 84 60" fill="none" stroke={HAIR} strokeWidth="6" strokeLinecap="round" />
      {/* round glasses -- "experienced doctor" shorthand */}
      <circle cx="49" cy="42" r="8" fill="none" stroke={INK} strokeWidth="2" />
      <circle cx="71" cy="42" r="8" fill="none" stroke={INK} strokeWidth="2" />
      <path d="M57 42 h6" stroke={INK} strokeWidth="2" />
      <path d="M41 40 L34 38" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M79 40 L86 38" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
      {mood === 'diagnosing' ? (
        <>
          <circle cx="49" cy="43" r="2.8" fill={INK} />
          <circle cx="71" cy="43" r="2.8" fill={INK} />
          <path d="M44 32 L54 34" stroke={INK} strokeWidth="2" strokeLinecap="round" />
          <path d="M66 34 L76 32" stroke={INK} strokeWidth="2" strokeLinecap="round" />
          {/* small mustache, focused closed-mouth expression */}
          <path d="M51 58 Q60 54 69 58" fill="none" stroke={HAIR} strokeWidth="4" strokeLinecap="round" />
          <path d="M53 63 Q60 66 67 63" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="49" cy="42" r="2.8" fill={INK} />
          <circle cx="71" cy="42" r="2.8" fill={INK} />
          <path d="M44 33 L54 32" stroke={INK} strokeWidth="2" strokeLinecap="round" />
          <path d="M66 32 L76 33" stroke={INK} strokeWidth="2" strokeLinecap="round" />
          <path d="M51 57 Q60 53 69 57" fill="none" stroke={HAIR} strokeWidth="4" strokeLinecap="round" />
          {/* warm open smile */}
          <path d="M51 63 Q60 72 69 63" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="40" cy="52" r="3.5" fill="var(--color-accent-300)" opacity="0.6" />
          <circle cx="80" cy="52" r="3.5" fill="var(--color-accent-300)" opacity="0.6" />
        </>
      )}
    </g>
  );
}

/** The brand's own BrandMark geometry (icons.tsx), small, worn as a chest pin -- drawn at the origin, positioned by the caller's own transform. */
function BrandPin() {
  return (
    <g>
      <circle r="9" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <ellipse rx="3" ry="9" fill="none" stroke={INK} strokeWidth="1" />
      <ellipse rx="6" ry="9" fill="none" stroke={INK} strokeWidth="1" />
      <path d="M-9 0 h18" stroke={INK} strokeWidth="1" />
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
      {/* a button, below the pin */}
      <circle cx="60" cy="118" r="2" fill={INK} />

      {/* stethoscope -- collar loop down to a chest piece, left of center */}
      <path d="M48 74 Q44 82 50 86 Q53 90 52 98" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
      <path d="M68 74 Q72 82 66 86" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
      <circle cx="52" cy="100" r="3.2" fill="#fff" stroke={INK} strokeWidth="1.8" />

      {/* the brand mark, worn as a chest pin, right of center */}
      <g transform="translate(72, 95) scale(0.7)">
        <BrandPin />
      </g>

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
        <DoctorHead mood={pose === 'diagnosing' ? 'diagnosing' : 'pleased'} />
      </g>
    </g>
  );
}
