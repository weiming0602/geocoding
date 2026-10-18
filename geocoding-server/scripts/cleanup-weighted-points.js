#!/usr/bin/env node
// Deletes Road Alerts weighted points not pinged in N days, so a route
// someone stopped driving eventually gets removed outright rather than
// just decaying toward (but never reaching) zero forever. Meant to run
// daily -- see ops/geocoding-weighted-points-cleanup.timer (or
// ops/crontab.example for a plain-cron alternative) -- so a stale point's
// worst-case lifetime stays close to the retention window itself rather
// than the window plus however long until the next run.
//
//   node scripts/cleanup-weighted-points.js [days]   (default: 21)

require('dotenv').config();

const { Pool } = require('../src/db');
const { ensureWeightedPointsTable, deleteStalePoints } = require('../src/weightedPoints');

const USERS_DSN =
  process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';

async function main() {
  const days = Number(process.argv[2]) || 21;
  const pool = new Pool({ connectionString: USERS_DSN });
  try {
    await ensureWeightedPointsTable(pool);
    const deleted = await deleteStalePoints(pool, days);
    console.log(`Deleted ${deleted} weighted point(s) not pinged in ${days} days`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
