const test = require('node:test');
const assert = require('node:assert/strict');

const { attemptLlmAssist } = require('../src/llmAssist');
const { makeDb, makeUsersDb } = require('./helpers');
const { parseAddress } = require('../src/parseAddress');
const { ensureLlmGeocodeAssistsTable, logLlmGeocodeAssist } = require('../src/llmGeocodeAssists');

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

test('attemptLlmAssist returns null without calling fetch when unconfigured', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  const db = await makeDb();
  const usersDb = await makeUsersDb();
  await ensureLlmGeocodeAssistsTable(usersDb);
  try {
    const parsed = parseAddress('997 Peqwket Trl, 04091');
    const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
    assert.equal(result, null);
  } finally {
    global.fetch = savedFetch;
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    await db.close();
    await usersDb.close();
  }
});

test('attemptLlmAssist returns null without calling fetch for an out-of-coverage address', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  const db = await makeDb();
  const usersDb = await makeUsersDb();
  await ensureLlmGeocodeAssistsTable(usersDb);
  try {
    await withApiKey(async () => {
      const parsed = parseAddress('123 Main St, Austin, TX 78701');
      const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '123 Main St, Austin, TX 78701', 20);
      assert.equal(result, null);
    })();
  } finally {
    global.fetch = savedFetch;
    await db.close();
    await usersDb.close();
  }
});

test('attemptLlmAssist returns null without calling fetch when there are no real candidates nearby', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  const db = await makeDb();
  const usersDb = await makeUsersDb();
  await ensureLlmGeocodeAssistsTable(usersDb);
  try {
    await withApiKey(async () => {
      const parsed = parseAddress('42 Zzyzx Quantum Blvd, 04091');
      const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '42 Zzyzx Quantum Blvd, 04091', 20);
      assert.equal(result, null);
    })();
  } finally {
    global.fetch = savedFetch;
    await db.close();
    await usersDb.close();
  }
});

test(
  'attemptLlmAssist: a picked candidate re-geocodes to real coordinates, flagged llm_assisted, and logs a succeeded row',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    }),
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      await ensureLlmGeocodeAssistsTable(usersDb);
      try {
        // "997 Peqwket Trl" (misspelled) should surface "Pequawket Trl" (id=12, zip 04091)
        // as the top candidate and re-geocode to its real coordinates.
        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.ok(result);
        assert.equal(result.source, 'llm_assisted');
        assert.equal(result.originalInput, '997 Peqwket Trl, 04091');
        assert.match(result.correctedAddress, /Pequawket Trl/);
        assert.ok(result.coordinates.latitude);
        assert.ok(result.coordinates.longitude);
        assert.equal(result.match.fullname, 'Pequawket Trl');

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, true);
        assert.equal(rows[0].email, 'demo@example.com');
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  'attemptLlmAssist: "none fit" returns null and logs a failed attempt with failure_reason none_fit',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'none', reason: 'nothing close enough' } }],
      }),
    }),
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      await ensureLlmGeocodeAssistsTable(usersDb);
      try {
        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.equal(result, null);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, false);
        assert.equal(rows[0].failure_reason, 'none_fit');
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  'attemptLlmAssist: an Anthropic API failure returns null and logs a failed attempt with failure_reason llm_error',
  withFakeFetch(
    () => {
      throw new Error('network down');
    },
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      await ensureLlmGeocodeAssistsTable(usersDb);
      try {
        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.equal(result, null);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, false);
        assert.equal(rows[0].failure_reason, 'llm_error');
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  'attemptLlmAssist: per-account daily cap blocks a 51st attempt without calling fetch',
  withFakeFetch(
    () => {
      throw new Error('fetch should not have been called -- the cap should short-circuit first');
    },
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      await ensureLlmGeocodeAssistsTable(usersDb);
      try {
        const email = 'capped@example.com';
        // Seed MAX_ASSISTS_PER_ACCOUNT_PER_DAY (50) rows directly, as if
        // this account already triggered 50 real LLM calls today.
        for (let i = 0; i < 50; i++) {
          await logLlmGeocodeAssist(usersDb, {
            email,
            originalInput: `997 Peqwket Trl, 0409${i % 10}`,
            candidates: [],
            picked: null,
            succeeded: false,
            failureReason: 'none_fit',
          });
        }

        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.equal(result, null);

        // The cap check itself doesn't log a row -- confirm the count is
        // still exactly the 50 seeded rows, not 51.
        const { rows } = await usersDb.query('SELECT count(*)::int AS n FROM llm_geocode_assists WHERE email = $1', [email]);
        assert.equal(rows[0].n, 50);
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  "attemptLlmAssist: a caller-given ZIP on the zipr side (Greely Rd's ZIP-boundary fixture) resolves against that side, not picked.zipl",
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    }),
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      await ensureLlmGeocodeAssistsTable(usersDb);
      try {
        // Greely Rd fixture (test/helpers.js): zipl 04021 / zipr 04097,
        // right-side (even) range 200-292. 250 is even and falls in that
        // range. The caller's own ZIP (04097, the zipr side) must be what
        // gets used for the rematch -- the old buggy code would have
        // blindly preferred picked.zipl (04021), which has no zipr=04021
        // row for this street at all and would 404.
        const parsed = parseAddress('250 Greeley Rd, 04097');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '250 Greeley Rd, 04097', 20);
        assert.ok(result);
        assert.equal(result.source, 'llm_assisted');
        assert.equal(result.match.fullname, 'Greely Rd');
        assert.equal(result.rangeSide, 'right');
        assert.equal(result.match.zipr, '04097');

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, true);
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  'attemptLlmAssist: a picked candidate whose ranges don\'t cover the house number returns null and logs failure_reason rematch_failed',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    }),
    withApiKey(async () => {
      const db = await makeDb();
      const usersDb = await makeUsersDb();
      await ensureLlmGeocodeAssistsTable(usersDb);
      try {
        // "Pequawket Trl" is real at ZIP 04091 (test/helpers.js), but every
        // seeded segment's ranges top out well below 9999 (max ltoadd 998),
        // so the picked candidate's street name is real but the rematch
        // against this house number must throw OutOfRangeError internally
        // -- caught here rather than escaping.
        const parsed = parseAddress('9999 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parsed, '9999 Peqwket Trl, 04091', 20);
        assert.equal(result, null);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].succeeded, false);
        assert.equal(rows[0].failure_reason, 'rematch_failed');
        assert.match(rows[0].picked, /Pequawket Trl/);
      } finally {
        await db.close();
        await usersDb.close();
      }
    })
  )
);

test(
  'attemptLlmAssist: an unexpected error from candidateStreetNames (e.g. a missing pg_trgm extension) degrades to null, not a thrown error',
  withFakeFetch(
    () => {
      throw new Error('fetch should not have been called -- the error should surface before the LLM call');
    },
    withApiKey(async () => {
      const realDb = await makeDb();
      const usersDb = await makeUsersDb();
      await ensureLlmGeocodeAssistsTable(usersDb);
      // Simulates a missing pg_trgm extension: candidateStreetNames' own
      // query (the only one here that references similarity()) throws,
      // same as Postgres would for `function similarity(text, text) does
      // not exist`.
      const fakeDb = {
        query: (sql, params) => {
          if (sql.includes('similarity')) {
            throw new Error('function similarity(text, text) does not exist');
          }
          return realDb.query(sql, params);
        },
      };
      try {
        const parsed = parseAddress('997 Peqwket Trl, 04091');
        const result = await attemptLlmAssist(fakeDb, { usersDb, email: 'demo@example.com' }, parsed, '997 Peqwket Trl, 04091', 20);
        assert.equal(result, null);

        const { rows } = await usersDb.query('SELECT * FROM llm_geocode_assists');
        assert.equal(rows.length, 0);
      } finally {
        await realDb.close();
        await usersDb.close();
      }
    })
  )
);
