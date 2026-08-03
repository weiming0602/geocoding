import { Link } from 'react-router';

import { PRICING_TIERS, formatUsd, perAddressRate } from '../../../shared/pricing';

export default function Pricing() {
  return (
    <div>
      <h1>Bulk geocoding pricing</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        One-time packs of additional monthly quota — applies to Batch geocoding. Single-address
        Geocode and Reverse geocode always stay free.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 'var(--space-4)' }}>
        {PRICING_TIERS.map((tier) => (
          <div key={tier.addressCount} className="card elev-sm">
            {tier.popular && <span className="tag tag-accent">Most popular</span>}
            <div className="card-kicker">{tier.label}</div>
            <div
              style={{
                fontFamily: 'var(--font-heading)',
                fontWeight: 'var(--font-heading-weight)',
                fontSize: 30,
              }}
            >
              {formatUsd(tier.priceCents)}
            </div>
            <div className="card-meta">{perAddressRate(tier)}</div>
            <Link className="btn btn-primary btn-block" to={`/checkout?tier=${tier.addressCount}`}>
              Buy
            </Link>
          </div>
        ))}
      </div>

      <div className="card" style={{ background: 'var(--color-surface)', marginTop: 'var(--space-6)' }}>
        <p className="card-body" style={{ margin: 0 }}>
          Purchases add to your account's monthly quota permanently (they don't expire at the end of
          the period). See <Link to="/plan-quota">Plan &amp; quota</Link> for your current usage.
        </p>
      </div>
    </div>
  );
}
