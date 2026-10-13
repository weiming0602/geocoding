#!/usr/bin/env node
// Deletes geocode_rate_limits rows older than N days, so the table
// doesn't accumulate forever. Meant to run periodically -- see
// ops/ for a systemd timer/service pair or crontab alternative,
// mirroring scripts/cleanup-feedback.js exactly.
//
//   node scripts/cleanup-geocode-rate-limits.js [days]   (default: 90)

require('dotenv').config();

const { Pool } = require('../src/db');
const { ensureGeocodeRateLimitsTable, deleteOldRateLimits } = require('../src/geocodeRateLimit');

const USERS_DSN =
  process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';

async function main() {
  const days = Number(process.argv[2]) || 90;
  const pool = new Pool({ connectionString: USERS_DSN });
  try {
    await ensureGeocodeRateLimitsTable(pool);
    const deleted = await deleteOldRateLimits(pool, days);
    console.log(`Deleted ${deleted} geocode_rate_limits row(s) older than ${days} days`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
