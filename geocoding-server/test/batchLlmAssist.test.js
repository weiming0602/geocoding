const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertUser } = require('../src/users');
const { geocodeAddressList } = require('../src/batchGeocode');
const { batchLlmAssist, MAX_ASSISTS_PER_ACCOUNT_PER_DAY, MAX_BATCH_ASSISTS_PER_ACCOUNT_PER_DAY } = require('../src/llmAssist');
const { ensureLlmGeocodeAssistsTable } = require('../src/llmGeocodeAssists');
const { withTestServer, makeDb, makeUsersDb } = require('./helpers');

// See geocodeLlmAssistEndpoint.test.js: the test's own requests to the
// local server must not go through the fake Anthropic fetch.
const realFetch = global.fetch;

// A fake Anthropic API that always picks the first candidate, counting calls.
function fakeAnthropic() {
  const calls = { count: 0 };
  const fetchFn = async () => {
    calls.count += 1;
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    };
  };
  return { calls, fetchFn };
}

async function withLlm(fetchFn, fn) {
  const savedFetch = global.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  global.fetch = fetchFn;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    await fn();
  } finally {
    global.fetch = savedFetch;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
}

const GOOD = '997 Pequawket Trl, Standish, ME 04091';
const MISSPELLED = '997 Peqwket Trl, 04091';

test('POST /geocode/batch: a paid run rescues a misspelled row with the LLM, leaving good rows alone', async () => {
  const { calls, fetchFn } = fakeAnthropic();
  await withLlm(fetchFn, () =>
    withTestServer(async ({ port, usersDb }) => {
      const user = await upsertUser(usersDb, 'batch@example.com', 100);
      const response = await realFetch(`http://127.0.0.1:${port}/geocode/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileContent: `${GOOD}\n${MISSPELLED}`, email: 'batch@example.com', serviceKey: user.service_key }),
      });
      assert.equal(response.status, 200);
      const { results } = await response.json();
      assert.equal(results[0].success, true);
      assert.notEqual(results[0].source, 'llm_assisted');
      assert.equal(results[1].success, true);
      assert.equal(results[1].source, 'llm_assisted');
      assert.equal(results[1].correctedStreet, 'Pequawket Trl');
      assert.equal(calls.count, 1, 'only the failed row reaches the LLM');

      const { rows } = await usersDb.query('SELECT context, succeeded FROM llm_geocode_assists WHERE email = $1', ['batch@example.com']);
      assert.deepEqual(rows, [{ context: 'batch', succeeded: true }]);
    })
  );
});

test('geocodeAddressList stops calling the LLM once the run budget is spent', async () => {
  const { calls, fetchFn } = fakeAnthropic();
  await withLlm(fetchFn, async () => {
    const db = await makeDb();
    const usersDb = await makeUsersDb();
    await ensureLlmGeocodeAssistsTable(usersDb);
    try {
      const llmAssist = batchLlmAssist(usersDb, 'budget@example.com');
      llmAssist.runBudget.remaining = 2;
      const results = await geocodeAddressList(db, [MISSPELLED, MISSPELLED, MISSPELLED, MISSPELLED, MISSPELLED], {
        offsetFeet: 20,
        llmAssist,
      });
      assert.equal(calls.count, 2);
      assert.equal(results.filter((r) => r.source === 'llm_assisted').length, 2);
      assert.equal(results.filter((r) => !r.success).length, 3);
      assert.match(results.find((r) => !r.success).error, /no street found matching/);
    } finally {
      await db.close();
      await usersDb.close();
    }
  });
});

test('batch and single geocodes have separate daily LLM caps', async () => {
  const { calls, fetchFn } = fakeAnthropic();
  await withLlm(fetchFn, async () => {
    const db = await makeDb();
    const usersDb = await makeUsersDb();
    await ensureLlmGeocodeAssistsTable(usersDb);
    const fill = (context, n) =>
      usersDb.query(
        `INSERT INTO llm_geocode_assists (email, original_input, candidates_considered, succeeded, context)
         SELECT 'caps@example.com', 'x', '[]'::jsonb, true, $1 FROM generate_series(1, $2)`,
        [context, n]
      );
    try {
      // Single geocodes used up their whole day -- batch still gets help.
      await fill('single', MAX_ASSISTS_PER_ACCOUNT_PER_DAY);
      let results = await geocodeAddressList(db, [MISSPELLED], { offsetFeet: 20, llmAssist: batchLlmAssist(usersDb, 'caps@example.com') });
      assert.equal(results[0].source, 'llm_assisted');
      assert.equal(calls.count, 1);

      // Batch's own daily cap reached -- no more calls.
      await fill('batch', MAX_BATCH_ASSISTS_PER_ACCOUNT_PER_DAY);
      results = await geocodeAddressList(db, [MISSPELLED], { offsetFeet: 20, llmAssist: batchLlmAssist(usersDb, 'caps@example.com') });
      assert.equal(results[0].success, false);
      assert.equal(calls.count, 1);
    } finally {
      await db.close();
      await usersDb.close();
    }
  });
});

// A "correction" that lands in a different town than the address names is
// rejected: from a real batch run, "16 Sammer St, Augusta, ME 04074"
// (04074 is Scarborough's ZIP) was read as Sawyer St in Scarborough,
// 90 km from Augusta. Fixture: Pequawket Trl is in Standish; Testville
// is ~40 km away; Nowhereton has no address points to check against.
test('an LLM correction far from the town the address names is rejected', async () => {
  const { fetchFn } = fakeAnthropic();
  await withLlm(fetchFn, async () => {
    const db = await makeDb();
    const usersDb = await makeUsersDb();
    await ensureLlmGeocodeAssistsTable(usersDb);
    try {
      const run = (address) =>
        geocodeAddressList(db, [address], { offsetFeet: 20, llmAssist: batchLlmAssist(usersDb, 'town@example.com') });
      const [wrongTown] = await run('997 Peqwket Trl, Testville, ME 04091');
      assert.equal(wrongTown.success, false);
      const [rightTown] = await run('997 Peqwket Trl, Standish, ME 04091');
      assert.equal(rightTown.source, 'llm_assisted');
      const [uncheckable] = await run('997 Peqwket Trl, Nowhereton, ME 04091');
      assert.equal(uncheckable.source, 'llm_assisted');

      const { rows } = await usersDb.query(
        "SELECT original_input, failure_reason FROM llm_geocode_assists WHERE failure_reason = 'town_mismatch'"
      );
      assert.deepEqual(rows, [{ original_input: '997 Peqwket Trl, Testville, ME 04091', failure_reason: 'town_mismatch' }]);
    } finally {
      await db.close();
      await usersDb.close();
    }
  });
});
