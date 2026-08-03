import { Link } from 'react-router';

import { useRecentLookups } from '../state/RecentLookups';

// The design handoff's Overview showed "Requests today: 4,812" and
// "Success rate: 99.2%" as hardcoded literals, and "Batch jobs running"
// assuming an async job queue -- none of that has a real backend source
// (geocoding-server does no request logging, and /geocode/batch is fully
// synchronous; see the corrected design doc's README/github.md). Rather
// than fabricate numbers, these tiles say so honestly. "Quota remaining"
// would be real, but needs an email and there's no session/login to
// supply one on a dashboard -- points at Plan & quota instead of
// awkwardly bolting an email field onto a stat tile.
export default function Overview() {
  const { recentLookups } = useRecentLookups();

  return (
    <div>
      <h1 style={{ fontSize: 42 }}>Overview</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Account status at a glance.
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
          <div className="card-meta">
            See <Link to="/plan-quota">Plan &amp; quota</Link>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 'var(--space-6)' }}>
        <div>
          <h4 style={{ marginBottom: 'var(--space-3)' }}>Recent activity</h4>
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
        <div>
          <h4 style={{ marginBottom: 'var(--space-3)' }}>Quick actions</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div className="card elev-sm">
              <div className="card-title">Geocode an address</div>
              <p className="card-body">Convert a street address to coordinates.</p>
              <Link className="btn btn-primary btn-block" to="/geocode">
                Open geocode
              </Link>
            </div>
            <div className="card elev-sm">
              <div className="card-title">Reverse geocode a point</div>
              <p className="card-body">Click a location on the map to get its address.</p>
              <Link className="btn btn-secondary btn-block" to="/reverse-geocode">
                Open reverse geocode
              </Link>
            </div>
            <div className="card elev-sm">
              <div className="card-title">Batch geocode a file</div>
              <p className="card-body">Upload or point at an address file and get a ZIP back.</p>
              <Link className="btn btn-secondary btn-block" to="/batch">
                Open batch
              </Link>
            </div>
            <div className="card elev-sm">
              <div className="card-title">Plan &amp; quota</div>
              <p className="card-body">Check this period's usage against your tier.</p>
              <Link className="btn btn-secondary btn-block" to="/plan-quota">
                Open plan
              </Link>
            </div>
            <div className="card elev-sm">
              <div className="card-title">Help guide</div>
              <p className="card-body">How address interpolation, aliases, and reverse geocoding work.</p>
              <Link className="btn btn-secondary btn-block" to="/help">
                Read the guide
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
