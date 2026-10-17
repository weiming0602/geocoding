// "Dr. Meridian", drawn in side profile facing right (toward whatever
// he's examining), not front-on -- a genuine profile silhouette (one
// visible eye near the nose, nose bump on the leading edge, ear toward
// the back, hair swept back), not a front-facing figure simply rotated.
// Full white/silver hair, round wire glasses, a blue shirt + tie under
// the white coat, a teal stethoscope, and the brand's own globe mark
// worn as a small chest pin. Chibi proportions (big head, short body)
// keep him readable at small size.
const INK = '#2b2420';
const COAT = '#fdfdfb';
const HAIR = '#f1f0ee';
const HAIR_SHADE = '#dcdad6';
const SKIN = '#fbdfc0';
const SHIRT = '#4f8fc0';
const TIE = '#2d5f8a';
const STETHOSCOPE = '#3f9c93';

function ProfileHead({ mood }: { mood: 'diagnosing' | 'pleased' }) {
  return (
    <g>
      {/* ear, behind the face */}
      <circle cx="46" cy="48" r="6" fill={SKIN} stroke={INK} strokeWidth="2" />

      {/* head/face silhouette, facing right: rounded back of skull,
          forehead sloping down to a nose bump on the leading edge, lips,
          chin tucking back in toward the jaw and neck */}
      <path
        d="M30 44
           C30 24 48 12 62 14
           C76 16 82 28 80 38
           C86 40 90 46 88 51
           C86 55 80 54 77 51
           C76 56 73 60 69 62
           C71 66 69 70 65 71
           C58 73 48 70 42 62
           C34 58 30 52 30 44 Z"
        fill={SKIN}
        stroke={INK}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />

      {/* hair, swept back over the top and down the back of the head */}
      <path
        d="M29 42
           C26 20 44 6 62 8
           C74 9 80 16 80 24
           C72 16 56 14 46 20
           C36 26 32 34 33 44
           C33 48 31 46 29 42 Z"
        fill={HAIR}
        stroke={INK}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M40 20 Q36 26 38 32" fill="none" stroke={HAIR_SHADE} strokeWidth="1.4" strokeLinecap="round" />

      {/* eyebrow, raised and kind */}
      <path d="M58 30 Q66 26 73 30" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />

      {/* round glasses, side view -- one lens, temple arm back toward the ear */}
      <circle cx="66" cy="38" r="8" fill="rgba(255,255,255,0.35)" stroke={INK} strokeWidth="2" />
      <path d="M58 37 L47 40" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="67" cy="39" r="2.6" fill={INK} />
      <circle cx="68" cy="37.7" r="0.9" fill="#fff" />

      {mood === 'diagnosing' ? (
        // closed, focused mouth
        <path d="M68 56 Q72 58 74 56" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
      ) : (
        <>
          {/* warm smile, profile curve */}
          <path d="M67 55 Q73 61 77 55" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
          <circle cx="72" cy="48" r="3.2" fill="var(--color-accent-300)" opacity="0.5" />
        </>
      )}
    </g>
  );
}

/** The brand's own BrandMark geometry (icons.tsx), small, worn as a chest pin -- drawn at the origin, positioned by the caller's own transform. */
function BrandPin() {
  return (
    <g>
      <circle r="8" fill="#fff" stroke={INK} strokeWidth="1.4" />
      <ellipse rx="2.6" ry="8" fill="none" stroke={INK} strokeWidth="0.9" />
      <ellipse rx="5.3" ry="8" fill="none" stroke={INK} strokeWidth="0.9" />
      <path d="M-8 0 h16" stroke={INK} strokeWidth="0.9" />
    </g>
  );
}

export default function DrMeridian({ pose }: { pose: 'diagnosing' | 'pleased' }) {
  return (
    <g>
      {/* legs, side view -- near leg stepping forward (right), far leg trailing */}
      <path d="M52 124 L46 148" stroke={INK} strokeWidth="7" strokeLinecap="round" />
      <path d="M62 126 L70 148" stroke={INK} strokeWidth="7" strokeLinecap="round" />
      <ellipse cx="44" cy="151" rx="7" ry="4" fill={INK} />
      <ellipse cx="74" cy="151" rx="8" ry="4" fill={INK} />

      {/* shirt + tie, peeking out at the collar */}
      <path d="M48 68 L62 78 L70 68 L68 90 L50 90 Z" fill={SHIRT} stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M56 74 L62 79 L66 74 L63 98 L59 98 Z" fill={TIE} stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />

      {/* coat body, side silhouette -- narrower than the front-facing version,
          front edge (facing right) has the open lapel */}
      <path
        d="M38 70 C50 62 66 62 76 70 L80 128 C64 136 44 136 34 128 Z"
        fill={COAT}
        stroke={INK}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M50 71 L60 80 L52 94" fill="none" stroke={INK} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="56" cy="108" r="1.8" fill={INK} />
      <circle cx="56" cy="120" r="1.8" fill={INK} />

      {/* stethoscope -- teal, collar loop down to a chest piece */}
      <path d="M46 72 Q40 80 48 86 Q52 90 50 98" fill="none" stroke={STETHOSCOPE} strokeWidth="2.8" strokeLinecap="round" />
      <circle cx="50" cy="100" r="3.2" fill="#fff" stroke={STETHOSCOPE} strokeWidth="2.2" />

      {/* the brand mark, worn as a chest pin */}
      <g transform="translate(66, 92) scale(0.65)">
        <BrandPin />
      </g>

      {pose === 'diagnosing' ? (
        // near arm extended forward, pointing at whatever he's facing
        <>
          <path d="M72 76 Q92 78 104 64" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
          <circle cx="106" cy="61" r="4" fill={INK} />
        </>
      ) : (
        // near arm relaxed, down at his side
        <path d="M70 76 Q78 92 72 108" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      )}

      <ProfileHead mood={pose === 'diagnosing' ? 'diagnosing' : 'pleased'} />
    </g>
  );
}
