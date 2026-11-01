const pg = require('pg');

const { types } = pg;

/**
 * pg's Pool, with an 'error' listener always attached. When Postgres
 * drops a connection sitting idle in the pool (a Postgres restart --
 * e.g. unattended-upgrades updating it -- an idle-session timeout, a
 * network blip), the pool emits 'error'; with no listener, Node treats
 * that as an uncaught exception and the whole process exits. That took
 * the API down (nginx 502 / connection refused until systemd restarted
 * it, killing every in-flight request, batch runs included) every time
 * it happened. The pool already discards the dead client and opens a new
 * one on the next query, so logging is all that's needed here. Every
 * pool in this app (servers and scripts) comes from this export.
 */
class Pool extends pg.Pool {
  constructor(config) {
    super(config);
    this.on('error', (err) => {
      console.error('[db] idle Postgres connection dropped; the pool will reconnect:', err.message);
    });
  }
}

// BIGSERIAL/BIGINT columns (OID 20) come back from pg as strings by
// default, to avoid silent precision loss above Number.MAX_SAFE_INTEGER.
// This app's ids (streets.id, users.id) won't realistically get anywhere
// near that, and the frontend's shared types declare id as a plain
// number (ui/shared/api/types.ts) -- so parse them as numbers here, once,
// before any pool is created. Must be required before any other module
// in this app creates a Pool.
types.setTypeParser(20, (value) => parseInt(value, 10));

/**
 * A Pool whose every connection is forced into
 * `default_transaction_read_only`, so a bug can't accidentally write
 * against the geocoding data no matter what GEOCODING_DSN is set to --
 * this is Postgres's equivalent of the old better-sqlite3
 * `{ readonly: true }` connection flag (only users.js's pool is writable).
 * Passed as a libpq startup parameter (`options`), not a SET query issued
 * after connecting -- a separate post-connect query would race the first
 * real query on that same connection, since Pool hands a client back to
 * its caller without waiting for 'connect' handlers to finish.
 */
function createReadOnlyPool(connectionString) {
  return new Pool({ connectionString, options: '-c default_transaction_read_only=on' });
}

module.exports = { Pool, createReadOnlyPool };
