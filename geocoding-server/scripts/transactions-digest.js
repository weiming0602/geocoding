#!/usr/bin/env node
// Emails the owner (TRANSACTIONS_NOTIFY_EMAIL) every purchase completed
// since the last digest, then marks them notified. Meant to run daily --
// see ops/geocoding-transactions-digest.timer (or ops/crontab.example
// for a plain-cron alternative).
//
//   node scripts/transactions-digest.js

require('dotenv').config();

const { Pool } = require('../src/db');
const { ensureTransactionsTable } = require('../src/transactions');
const { runDailyTransactionsDigest } = require('../src/transactionsDigest');

const USERS_DSN =
  process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';

async function main() {
  const pool = new Pool({ connectionString: USERS_DSN });
  try {
    await ensureTransactionsTable(pool);
    const { transactionsNotified, emailSent } = await runDailyTransactionsDigest(pool);
    console.log(`Notified owner of ${transactionsNotified} transaction(s), email sent: ${emailSent}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
