// Bulk/batch geocoding pricing -- the server's own authoritative copy,
// used to validate a purchase's claimed tier/price server-side (never
// trust a client-supplied price). Keep in sync by hand with
// ui/shared/pricing.ts, which both frontends use to render pricing UI --
// same dual-maintenance pattern as the odd/even parity rule (see
// CLAUDE.md): duplicated on purpose across a language/trust boundary.
const PRICING_TIERS = [
  { addressCount: 500, priceCents: 900 },
  { addressCount: 1000, priceCents: 1500 },
  { addressCount: 2000, priceCents: 2500 },
  { addressCount: 10000, priceCents: 7500 },
];

function findTier(addressCount) {
  return PRICING_TIERS.find((t) => t.addressCount === addressCount);
}

module.exports = { PRICING_TIERS, findTier };
