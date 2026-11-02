const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('pg');

const { withTestServer } = require('./helpers');

// Regression: when Postgres dropped a connection idling in a pool (a
// Postgres restart, an idle timeout...), the pool emitted 'error' with no
// listener and the whole server process exited -- every request after it
// got "connection refused" until systemd restarted it.

async function terminateConnectionsTo(dbName) {
  const admin = new pg.Client({ connectionString: 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      'SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1',
      [dbName]
    );
    return rows[0].n;
  } finally {
    await admin.end();
  }
}

test('the server survives Postgres dropping its idle connections, and reconnects', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const quota = () => fetch(`http://127.0.0.1:${port}/quota?email=nobody@example.com`).then((r) => r.status);
      assert.equal(await quota(), 404);

      const { rows } = await usersDb.query('SELECT current_database() AS name');
      // Before the fix, this made the users pool emit an unhandled 'error',
      // crashing this test process along with the server.
      assert.ok((await terminateConnectionsTo(rows[0].name)) > 0);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // A fresh connection is opened for the next request.
      assert.equal(await quota(), 404);
    },
    { seedStreets: false }
  ));
