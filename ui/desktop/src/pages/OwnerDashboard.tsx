import { useRecentLookups } from '../state/RecentLookups';

// Split out of Overview.tsx -- the stat tiles and recent-activity table
// aren't customer-facing, they're for whoever runs the business to
// check in on. Not linked from the main nav (see Layout.tsx's NAV_LINKS)
// on purpose, so a regular visitor won't stumble onto it; there's no
// login system in this app yet, so this is obscurity, not real access
// control -- don't treat it as a security boundary if real sensitive
// data ever lands here.
export default function OwnerDashboard() {
  const { recentLookups } = useRecentLookups();

  return (
    <div>
      <h1 style={{ fontSize: 42 }}>Owner dashboard</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Not linked anywhere in the app -- bookmark this page if you want to check back on it.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
        <div className="card elev-sm">
          <div className="card-kicker">Requests today</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            Not tracked
          </div>
          <div className="card-meta">No request logging yet</div>
        </div>
        <div className="card elev-sm">
          <div className="card-kicker">Batch jobs running</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            N/A
          </div>
          <div className="card-meta">Batch runs synchronously — no queue</div>
        </div>
        <div className="card elev-sm">
          <div className="card-kicker">Success rate</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            Not tracked
          </div>
          <div className="card-meta">No request logging yet</div>
        </div>
        <div className="card elev-sm">
          <div className="card-kicker">Quota remaining</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            —
          </div>
          <div className="card-meta">Check a specific account on Plan &amp; quota</div>
        </div>
      </div>

      <h4 style={{ marginBottom: 'var(--space-3)' }}>Recent activity (this browser only)</h4>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Coordinates</th>
              <th>Side</th>
            </tr>
          </thead>
          <tbody>
            {recentLookups.length === 0 && (
              <tr>
                <td colSpan={3} className="text-muted">
                  Nothing yet this session — try Geocode or Reverse geocode.
                </td>
              </tr>
            )}
            {recentLookups.map((lookup, index) => (
              <tr key={index}>
                <td>{lookup.address}</td>
                <td className="text-muted" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                  {lookup.latitude.toFixed(5)}, {lookup.longitude.toFixed(5)}
                </td>
                <td>
                  <span className="tag tag-accent">{lookup.rangeSide}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
