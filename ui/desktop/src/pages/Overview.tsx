import { Link } from 'react-router';

// Stat tiles and recent-activity were split out to OwnerDashboard.tsx
// (not linked from the nav) -- they were never customer-facing info,
// just internal status the person running the business would check.
export default function Overview() {
  return (
    <div>
      <h1 style={{ fontSize: 42 }}>Overview</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        What would you like to do?
      </p>

      <div style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
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
  );
}
