const test = require('node:test');
const assert = require('node:assert/strict');

const { attemptLlmAssist } = require('../src/llmAssist');
const { makeDb, makeUsersDb } = require('./helpers');
const { parseAddress } = require('../src/parseAddress');
const { ensureLlmGeocodeAssistsTable } = require('../src/llmGeocodeAssists');

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
