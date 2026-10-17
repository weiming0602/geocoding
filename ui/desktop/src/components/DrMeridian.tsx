// "Dr. Meridian" -- a cute, kindly old-doctor character, redesigned to
// match a specific reference: full white/silver hair (not balding),
// visible ears, thick arched eyebrows, round wire glasses, a defined
// nose, a warm closed smile, a blue shirt + tie under the white coat,
// and a distinctly-colored (teal) stethoscope -- a more finished,
// lightly-colored illustration style than this component's first pass,
// which was closer to a loose ink sketch. Wears the brand's own globe
// mark as a small chest pin rather than as his face (an earlier version
// used the globe geometry as the head itself; it read as a mask, not a
// face). Chibi proportions (big head, short body) keep him readable
// inside a small square panel.
const INK = '#2b2420';
const COAT = '#fdfdfb';
const HAIR = '#f1f0ee';
const HAIR_SHADE = '#dcdad6';
const SKIN = '#fbdfc0';
const SHIRT = '#4f8fc0';
const TIE = '#2d5f8a';
const STETHOSCOPE = '#3f9c93';

function DoctorHead({ mood }: { mood: 'diagnosing' | 'pleased' }) {
  return (
    <g>
      {/* ears, behind the head outline */}
      <circle cx="31" cy="46" r="6" fill={SKIN} stroke={INK} strokeWidth="2" />
      <circle cx="89" cy="46" r="6" fill={SKIN} stroke={INK} strokeWidth="2" />

      {/* head */}
      <circle cx="60" cy="44" r="28" fill={SKIN} stroke={INK} strokeWidth="2.4" />

      {/* full white/silver hair, swept up and back -- not balding */}
      <path
        d="M30 42 Q26 10 60 8 Q94 10 90 42 Q88 24 78 18 Q82 30 76 24 Q74 14 60 13 Q46 14 44 24 Q38 30 42 18 Q32 24 30 42 Z"
        fill={HAIR}
        stroke={INK}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M46 20 Q44 26 46 32" fill="none" stroke={HAIR_SHADE} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M74 20 Q76 26 74 32" fill="none" stroke={HAIR_SHADE} strokeWidth="1.6" strokeLinecap="round" />

      {/* defined, rounded nose */}
      <path d="M58 46 Q56 54 60 55 Q64 54 62 46" fill={SKIN} stroke={INK} strokeWidth="1.6" strokeLinecap="round" />

      {/* gentle, raised eyebrows -- set further above the eyes so they read as
          kind/attentive rather than furrowed */}
      <path d="M41 33 Q47 29 55 32" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M65 32 Q73 29 79 33" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />

      {/* round wire glasses */}
      <circle cx="49" cy="44" r="9" fill="rgba(255,255,255,0.35)" stroke={INK} strokeWidth="2" />
      <circle cx="71" cy="44" r="9" fill="rgba(255,255,255,0.35)" stroke={INK} strokeWidth="2" />
      <path d="M58 44 h4" stroke={INK} strokeWidth="2" />
      <path d="M40 42 L32 40" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M80 42 L88 40" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
      {/* pupils with a small white catchlight -- a plain flat dot under thick
          brows read as stern/angry; the highlight is what makes an eye look
          kind rather than beady */}
      <circle cx="49" cy="45" r="2.8" fill={INK} />
      <circle cx="71" cy="45" r="2.8" fill={INK} />
      <circle cx="50" cy="43.7" r="0.9" fill="#fff" />
      <circle cx="72" cy="43.7" r="0.9" fill="#fff" />

      {mood === 'diagnosing' ? (
        // closed, gently curious mouth -- examining, not stern
        <path d="M52 62 Q60 65 68 62" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
      ) : (
        <>
          {/* warm closed smile, with gentle smile-crease lines */}
          <path d="M51 61 Q60 69 69 61" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M48 58 Q46 61 48 64" fill="none" stroke={INK} strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
          <path d="M72 58 Q74 61 72 64" fill="none" stroke={INK} strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
          <circle cx="38" cy="54" r="3.5" fill="var(--color-accent-300)" opacity="0.5" />
          <circle cx="82" cy="54" r="3.5" fill="var(--color-accent-300)" opacity="0.5" />
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

      {/* blue shirt + tie, peeking out above the coat's open collar */}
      <path d="M50 70 L60 82 L70 70 L70 92 L50 92 Z" fill={SHIRT} stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M56 76 L60 83 L64 76 L62 102 L58 102 Z" fill={TIE} stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />

      {/* coat body, open over the shirt/tie */}
      <path
        d="M42 72 Q60 64 78 72 L82 130 Q60 138 38 130 Z"
        fill={COAT}
        stroke={INK}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* open lapels */}
      <path d="M50 73 L58 82 L48 96" fill="none" stroke={INK} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M70 73 L62 82 L72 96" fill="none" stroke={INK} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {/* buttons */}
      <circle cx="60" cy="112" r="2" fill={INK} />
      <circle cx="60" cy="124" r="2" fill={INK} />

      {/* stethoscope -- teal, collar loop down to a chest piece, left of center */}
      <path d="M46 75 Q40 84 48 90 Q53 94 52 102" fill="none" stroke={STETHOSCOPE} strokeWidth="3" strokeLinecap="round" />
      <path d="M70 75 Q76 84 68 90" fill="none" stroke={STETHOSCOPE} strokeWidth="3" strokeLinecap="round" />
      <circle cx="52" cy="104" r="3.6" fill="#fff" stroke={STETHOSCOPE} strokeWidth="2.4" />

      {/* the brand mark, worn as a chest pin, right of center */}
      <g transform="translate(72, 97) scale(0.7)">
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
          {/* both arms relaxed */}
          <path d="M42 78 Q33 92 37 108" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
          <path d="M78 78 Q87 92 83 108" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
        </>
      )}

      <DoctorHead mood={pose === 'diagnosing' ? 'diagnosing' : 'pleased'} />
    </g>
  );
}
