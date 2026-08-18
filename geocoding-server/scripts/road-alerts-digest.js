#!/usr/bin/env node
// Emails each opted-in Road Alerts account a digest of alerts they
// explicitly saved (voice "save"/"keep"/"email" command) since the last
// digest, then clears what was sent. Meant to run daily -- see
// ops/geocoding-road-alerts-digest.timer (or ops/crontab.example for a
// plain-cron alternative).
//
//   node scripts/road-alerts-digest.js

require('dotenv').config();

const { Pool } = require('../src/db');
const { ensureRoadAlertsAccountsTable } = require('../src/roadAlertsAccounts');
const { ensureRoadAlertsSurfacedLogTable } = require('../src/roadAlertsSurfacedLog');
const { runDailyDigest } = require('../src/roadAlertsDigest');

const USERS_DSN =
  process.env.USERS_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding_users';

async function main() {
  const pool = new Pool({ connectionString: USERS_DSN });
  try {
    await ensureRoadAlertsAccountsTable(pool);
    await ensureRoadAlertsSurfacedLogTable(pool);
    const { accountsDigested, emailsSent } = await runDailyDigest(pool);
    console.log(`Digested ${accountsDigested} account(s), sent ${emailsSent} email(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
