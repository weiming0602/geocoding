#!/usr/bin/env node
// Manual stand-in for a billing/payment flow that doesn't exist yet:
// run this to grant or change a user's monthly quota.
//
//   node scripts/manage-user.js set alice@example.com 10000
//   node scripts/manage-user.js show alice@example.com
//   node scripts/manage-user.js list

const { openUsersDb, upsertUser, getUser } = require('../src/users');

const USERS_DB_PATH =
  process.env.USERS_DB_PATH || 'C:\\software\\database\\sqlite3\\users.sqlite';

function printUser(user) {
  if (!user) {
    console.log('no such user');
    return;
  }
  console.log(
    `${user.email}: tier=${user.tier}, used_this_period=${user.used_this_period}, ` +
      `period_start=${user.period_start}`
  );
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const db = openUsersDb(USERS_DB_PATH);

  try {
    if (command === 'set') {
      const [email, tierArg] = args;
      const tier = Number(tierArg);
      if (!email || !Number.isFinite(tier) || tier <= 0) {
        throw new Error('usage: manage-user.js set <email> <tier>');
      }
      printUser(upsertUser(db, email, tier));
    } else if (command === 'show') {
      const [email] = args;
      if (!email) throw new Error('usage: manage-user.js show <email>');
      printUser(getUser(db, email));
    } else if (command === 'list') {
      const rows = db.prepare('SELECT * FROM users ORDER BY email').all();
      if (rows.length === 0) console.log('no users');
      rows.forEach(printUser);
    } else {
      console.log('usage: manage-user.js <set|show|list> ...');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main();
