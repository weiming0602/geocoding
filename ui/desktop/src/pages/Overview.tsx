import { Link } from 'react-router';

import { PRICING_TIERS, formatUsd, perAddressRate } from '../../../shared/pricing';
import { Icon, type IconName } from '../components/icons';

const TASKS: { title: string; body: string; to: string; cta: string; icon: IconName; primary?: boolean }[] = [
  {
    title: 'Geocode an address',
    body: 'Convert a street address to coordinates.',
    to: '/geocode',
    cta: 'Open geocode',
    icon: 'geocode',
    primary: true,
  },
  {
    title: 'Batch geocode a file',
    body: 'Upload or point at an address file and get a ZIP back.',
    to: '/batch',
    cta: 'Open batch',
    icon: 'batch',
  },
  {
    title: 'Import a messy export',
    body: 'CSV or Excel with columns to sort out first -- turn it into a clean address list.',
    to: '/import-addresses',
    cta: 'Import addresses',
    icon: 'importAddresses',
  },
  {
    title: 'Reverse geocode a point',
    body: 'Click a location on the map to get its address.',
    to: '/reverse-geocode',
    cta: 'Open reverse geocode',
    icon: 'reverseGeocode',
  },
  {
    title: 'Find places near an address',
    body: 'Search for a kind of place nearby and export the matches.',
    to: '/find-places',
    cta: 'Open find places',
    icon: 'findPlaces',
  },
];

// Split out to OwnerDashboard.tsx (not linked from the nav) -- stat tiles
// and recent activity were never customer-facing info, just internal
// status the person running the business would check.
export default function Overview() {
  const popularTier = PRICING_TIERS.find((t) => t.popular) ?? PRICING_TIERS[0];

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: 'var(--space-8)',
          alignItems: 'center',
          marginBottom: 'var(--space-8)',
        }}
      >
        <div>
          <span className="tag tag-accent-2" style={{ marginBottom: 'var(--space-3)' }}>
            Maine &amp; New Hampshire
          </span>
          <h1 style={{ marginTop: 'var(--space-3)' }}>Real addresses, not just estimates</h1>
          <p className="text-muted" style={{ fontSize: 18, marginBottom: 'var(--space-4)' }}>
            Meridian matches Maine addresses against real, surveyed E911 points -- not a
            proportional guess along a street. Single lookups, reverse geocoding, and batch files,
            self-serve with no API key application to wait on.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to="/geocode">
              Try a free lookup
            </Link>
            <Link className="btn btn-secondary" to="/pricing">
              See pricing
            </Link>
          </div>
        </div>
        <div className="plate">
          <img
            src="/help/chestnut-91-left.png"
            alt="A map showing house number 91 matched to the left side of Chestnut Rd"
            style={{ display: 'block', width: '100%' }}
          />
          <p className="text-muted" style={{ fontSize: 12, margin: 'var(--space-2) 0 0' }}>
            A real match -- see <Link to="/help">how it works</Link>.
          </p>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-8)',
        }}
      >
        <div className="card">
          <div className="card-kicker">Real accuracy</div>
          <div className="card-title">Real per-house locations for Maine</div>
          <p className="card-body">
            Matched against real, surveyed E911 address points before ever falling back to
            estimated range interpolation.
          </p>
        </div>
        <div className="card">
          <div className="card-kicker">No setup</div>
          <div className="card-title">Self-serve, no API key hoops</div>
          <p className="card-body">
            Buy a pack, get a service key by email, start geocoding -- no approval process, no
            minimum contract.
          </p>
        </div>
        <div className="card">
          <div className="card-kicker">Focused coverage</div>
          <div className="card-title">Built for Maine &amp; New Hampshire</div>
          <p className="card-body">
            Not a thin slice of a nationwide dataset -- built specifically for these two states'
            streets and addresses.
          </p>
        </div>
      </div>

      <h2 style={{ marginBottom: 'var(--space-1)' }}>What would you like to do?</h2>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Everything below works without an account -- a plan is only needed for batch geocoding
        past the free tier.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-6)',
        }}
      >
        {TASKS.map((task) => (
          <div key={task.to} className="card elev-sm">
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <span className="task-icon-tile">
                <Icon name={task.icon} size={19} />
              </span>
              {task.title}
            </div>
            <p className="card-body">{task.body}</p>
            <Link
              className={`btn btn-block ${task.primary ? 'btn-primary' : 'btn-secondary'}`}
              to={task.to}
            >
              {task.cta}
            </Link>
          </div>
        ))}
      </div>

      <div
        className="card"
        style={{
          background: 'var(--color-surface)',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <p className="card-body" style={{ margin: 0 }}>
          Batch packs start at <strong>{formatUsd(popularTier.priceCents)}</strong> for{' '}
          {popularTier.label} ({perAddressRate(popularTier)}) -- purchases don't expire.
        </p>
        <Link className="btn btn-primary" to="/pricing">
          See pricing
        </Link>
      </div>
    </div>
  );
}
