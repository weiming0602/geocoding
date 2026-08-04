const { types, Pool } = require('pg');

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
