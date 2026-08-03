// Bulk/batch geocoding pricing -- there's no real product/billing system
// yet (see geocoding-server/src/billing.js, a deliberate stub mirroring
// emailDelivery.js), so this is the single source of truth both apps'
// pricing and checkout pages read from, and what the stub purchase
// endpoint validates addressCount/priceCents against server-side.

export type PricingTier = {
  addressCount: number;
  priceCents: number;
  label: string;
  popular?: boolean;
};

export const PRICING_TIERS: PricingTier[] = [
  { addressCount: 500, priceCents: 900, label: '500 addresses' },
  { addressCount: 1000, priceCents: 1500, label: '1,000 addresses', popular: true },
  { addressCount: 2000, priceCents: 2500, label: '2,000 addresses' },
  { addressCount: 10000, priceCents: 7500, label: '10,000 addresses' },
];

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

export function perAddressRate(tier: PricingTier): string {
  return `${(tier.priceCents / tier.addressCount).toFixed(2)}¢/address`;
}

export function findTier(addressCount: number): PricingTier | undefined {
  return PRICING_TIERS.find((t) => t.addressCount === addressCount);
}
