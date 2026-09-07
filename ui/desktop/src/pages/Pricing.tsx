import { Link } from 'react-router';

import { PRICING_TIERS, formatUsd, perAddressRate } from '../../../shared/pricing';
import AccountTabs from '../components/AccountTabs';
import PageHeader from '../components/PageHeader';

export default function Pricing() {
  return (
    <div>
      <PageHeader icon="pricing">Bulk geocoding pricing</PageHeader>
      <AccountTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        One-time packs of additional monthly quota — applies to Batch geocoding. Single-address
        Geocode and Reverse geocode always stay free.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 'var(--space-4)' }}>
        {PRICING_TIERS.map((tier) => (
          <div key={tier.addressCount} className="card elev-sm">
            {/* Rendered (with visibility: hidden, not display: none) on every
                card, not just the popular one -- otherwise the badge's extra
                line only exists in one card's flex column, and every "Buy"
                button below it ends up at a different height than its
                siblings. Reserving the same space on all four keeps the row
                of buttons aligned regardless of which tier is marked popular. */}
            <span className="tag tag-accent" style={{ visibility: tier.popular ? 'visible' : 'hidden' }}>
              Most popular
            </span>
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
