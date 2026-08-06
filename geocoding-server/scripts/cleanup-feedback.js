#!/usr/bin/env node
// Deletes feedback older than N days, so the table (and any email
// addresses left with old comments) doesn't accumulate forever.
// Meant to run periodically -- see ops/geocoding-feedback-cleanup.timer
// (or ops/crontab.example for a plain-cron alternative).
//
//   node scripts/cleanup-feedback.js [days]   (default: 90)

require('dotenv').config();

const { Pool } = require('../src/db');
const { ensureFeedbackTable, deleteOldFeedback } = require('../src/feedback');

const USERS_DSN =
  process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';

async function main() {
  const days = Number(process.argv[2]) || 90;
  const pool = new Pool({ connectionString: USERS_DSN });
  try {
    await ensureFeedbackTable(pool);
    const deleted = await deleteOldFeedback(pool, days);
    console.log(`Deleted ${deleted} feedback row(s) older than ${days} days`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
