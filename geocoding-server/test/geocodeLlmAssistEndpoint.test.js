const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser } = require('../src/users');
const { geocodeAddressList } = require('../src/batchGeocode');
const { withTestServer, makeDb } = require('./helpers');

// Captured once, before any test below ever reassigns global.fetch, so the
// tests' own HTTP calls to the local test server (below) always go out over
// a real loopback connection -- a bare `fetch(...)` inside a test resolves
// dynamically against whatever global.fetch currently is, same as
// anthropicClient.js's own call does, so without this, overriding
// global.fetch to a stub/throw (to control what the *server* sees when it
// calls out to Anthropic) would also hijack the test's own request to the
// port it's trying to exercise.
const realFetch = global.fetch;

function withFakeFetch(respond, fn) {
  return async () => {
    const saved = global.fetch;
    global.fetch = respond;
    try {
      await fn();
    } finally {
      global.fetch = saved;
    }
  };
}

function withApiKey(fn) {
  return async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  };
}

test(
  'POST /geocode: an authenticated request with a misspelled street gets an LLM-assisted match',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    }),
    withApiKey(() =>
      withTestServer(async ({ port, usersDb }) => {
        const user = await upsertUser(usersDb, 'demo@example.com', 100);

        const response = await realFetch(`http://127.0.0.1:${port}/geocode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: '997 Peqwket Trl, 04091',
            email: 'demo@example.com',
            serviceKey: user.service_key,
          }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.source, 'llm_assisted');
        assert.equal(body.originalInput, '997 Peqwket Trl, 04091');
        assert.match(body.correctedAddress, /Pequawket Trl/);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists WHERE email = $1', ['demo@example.com']);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, true);
      })
    )
  )
);

test('POST /geocode: an unauthenticated request with the same misspelled street never calls the LLM and gets a plain 404', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called for an unauthenticated request');
  };
  try {
    await withApiKey(() =>
      withTestServer(async ({ port }) => {
        const response = await realFetch(`http://127.0.0.1:${port}/geocode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: '997 Peqwket Trl, 04091' }),
        });
        assert.equal(response.status, 404);
      })
    )();
  } finally {
    global.fetch = savedFetch;
  }
});

test('POST /geocode: an authenticated request still gets today\'s plain 404 when ANTHROPIC_API_KEY is unset', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called when unconfigured');
  };
  try {
    await withTestServer(async ({ port, usersDb }) => {
      const user = await upsertUser(usersDb, 'demo2@example.com', 100);
      const response = await realFetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: '997 Peqwket Trl, 04091',
          email: 'demo2@example.com',
          serviceKey: user.service_key,
        }),
      });
      assert.equal(response.status, 404);
    });
  } finally {
    global.fetch = savedFetch;
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('Batch geocoding without a batch LLM context never triggers the LLM, even with a misspelled, otherwise-assistable address', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called during a batch run');
  };
  try {
    await withApiKey(async () => {
      const db = await makeDb();
      try {
        const results = await geocodeAddressList(db, ['997 Peqwket Trl, 04091'], { offsetFeet: 20 });
        assert.equal(results.length, 1);
        // A single-geocode context (no batch run budget) is stripped too --
        // its 50/day cap was never meant to bound a whole file.
        const withSingleContext = await geocodeAddressList(db, ['997 Peqwket Trl, 04091'], {
          offsetFeet: 20,
          llmAssist: { usersDb: null, email: 'demo@example.com' },
        });
        assert.equal(withSingleContext[0].success, false);
        assert.equal(results[0].success, false);
        assert.match(results[0].error, /no street found matching/);
      } finally {
        await db.close();
      }
    })();
  } finally {
    global.fetch = savedFetch;
  }
});
