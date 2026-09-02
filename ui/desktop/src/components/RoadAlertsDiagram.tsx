// A step-by-step flow of what Road Alerts actually does today, for the
// Help page. Deliberately doesn't include "weighted points" (routine-
// street matching) -- that's a real field in the API and a real code
// path (roadAlertsMatching.ts), but weightedPoints is always empty for
// a real account (no on-device trip-learning exists yet to populate it
// from -- see RoadAlertsForm.tsx's own comment on the prop). Documenting
// it here as something Road Alerts does would overstate what a real
// user's account actually does; what's below is the real, live pipeline
// (radius + heading-cone filtering, severity, reroute, navigation
// hand-off).
export default function RoadAlertsDiagram() {
  const box = { fill: 'var(--color-surface)', stroke: 'var(--color-divider)' };
  const textStyle = { fontFamily: 'var(--font-body)', fontSize: 13, fill: 'var(--color-text)' };
  const capStyle = { fontFamily: 'var(--font-body)', fontSize: 11, fill: 'var(--color-text)', opacity: 0.65 };

  return (
    <svg viewBox="0 0 600 900" width="100%" role="img" aria-label="Diagram of how Road Alerts detects and routes around a hazard">
      <defs>
        <marker id="rad-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill="var(--color-accent)" />
        </marker>
      </defs>

      {/* 1. Driving */}
      <rect x="100" y="20" width="400" height="56" rx="10" {...box} />
      <text x="300" y="54" textAnchor="middle" style={textStyle}>You start driving</text>
      <line x1="300" y1="76" x2="300" y2="112" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />

      {/* 2. GPS */}
      <rect x="100" y="116" width="400" height="56" rx="10" fill="var(--color-accent-2-100)" stroke="var(--color-accent-2)" />
      <text x="300" y="150" textAnchor="middle" style={textStyle}>App watches your GPS position + heading</text>
      <line x1="300" y1="172" x2="300" y2="208" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />

      {/* 3. 511 fetch */}
      <rect x="100" y="212" width="400" height="56" rx="10" {...box} />
      <text x="300" y="240" textAnchor="middle" style={textStyle}>Checks New England 511 for hazards</text>
      <text x="300" y="257" textAnchor="middle" style={textStyle}>within about 10 km of you</text>
      <line x1="300" y1="268" x2="300" y2="304" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />

      {/* 4. Decision diamond */}
      <polygon points="300,304 460,352 300,400 140,352" fill="var(--color-accent-100)" stroke="var(--color-accent)" strokeWidth="1.5" />
      <text x="300" y="348" textAnchor="middle" style={textStyle}>Is it ahead of you --</text>
      <text x="300" y="365" textAnchor="middle" style={textStyle}>the way you're heading?</text>

      {/* branch lines */}
      <line x1="200" y1="378" x2="120" y2="426" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />
      <text x="130" y="418" textAnchor="middle" style={{ ...textStyle, fontSize: 12, fontWeight: 600 }}>Yes</text>
      <line x1="400" y1="378" x2="480" y2="426" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />
      <text x="470" y="418" textAnchor="middle" style={{ ...textStyle, fontSize: 12, fontWeight: 600 }}>No</text>

      {/* Yes box */}
      <rect x="20" y="430" width="260" height="64" rx="10" fill="var(--color-accent-2-100)" stroke="var(--color-accent-2)" />
      <text x="150" y="458" textAnchor="middle" style={textStyle}>Spoken aloud right away,</text>
      <text x="150" y="476" textAnchor="middle" style={textStyle}>shown at the top of your list</text>

      {/* No box */}
      <rect x="320" y="430" width="260" height="64" rx="10" {...box} />
      <text x="450" y="458" textAnchor="middle" style={textStyle}>Still shown in your list,</text>
      <text x="450" y="476" textAnchor="middle" style={textStyle}>marked "behind you"</text>

      {/* merge lines down to the reroute step */}
      <line x1="150" y1="494" x2="150" y2="520" stroke="var(--color-accent)" strokeWidth="2" />
      <line x1="450" y1="494" x2="450" y2="520" stroke="var(--color-accent)" strokeWidth="2" />
      <line x1="150" y1="520" x2="450" y2="520" stroke="var(--color-accent)" strokeWidth="2" />
      <line x1="300" y1="520" x2="300" y2="546" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />

      {/* 5. Tap show a way around */}
      <rect x="100" y="550" width="400" height="56" rx="10" {...box} />
      <text x="300" y="584" textAnchor="middle" style={textStyle}>You tap "Show a way around this"</text>
      <line x1="300" y1="606" x2="300" y2="642" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />

      {/* 6. Reroute compute */}
      <rect x="100" y="646" width="400" height="72" rx="10" fill="var(--color-accent-2-100)" stroke="var(--color-accent-2)" />
      <text x="300" y="678" textAnchor="middle" style={textStyle}>Our own street data (not Google's) finds</text>
      <text x="300" y="696" textAnchor="middle" style={textStyle}>up to 3 routes around the hazard</text>
      <line x1="300" y1="718" x2="300" y2="754" stroke="var(--color-accent)" strokeWidth="2" markerEnd="url(#rad-arrow)" />

      {/* 7. Google Maps handoff */}
      <rect x="100" y="758" width="400" height="72" rx="10" fill="#efe7fb" stroke="#7c3aed" />
      <text x="300" y="790" textAnchor="middle" style={textStyle}>You pick a route, then hand it to</text>
      <text x="300" y="808" textAnchor="middle" style={textStyle}>Google Maps for real turn-by-turn directions</text>

      <text x="300" y="856" textAnchor="middle" style={capStyle}>
        Registration, comments, and saving an alert for later aren't shown here -- see the sections above.
      </text>
    </svg>
  );
}
