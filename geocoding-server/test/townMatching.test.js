const test = require('node:test');
const assert = require('node:assert/strict');

const { geocode } = require('../src/geocode');
const { matchByStreetAndTown } = require('../src/geocodeMatching');
const { attemptLlmAssist } = require('../src/llmAssist');
const { parseAddress } = require('../src/parseAddress');
const { ensureLlmGeocodeAssistsTable } = require('../src/llmGeocodeAssists');
const { OutOfRangeError } = require('../src/errors');
const { makeDb, makeUsersDb } = require('./helpers');

// Fixture towns/streets: see the towns block in helpers.js's seedFixtureStreets.

test('a street in the named town is found despite a ZIP from another town, flagged correctedZip', async () => {
  const db = await makeDb();
  try {
    const result = await geocode(db, '10 Forest Ave, Lebanon, NH 03301');
    assert.equal(result.match.id, 70);
    assert.equal(result.match.town, 'Lebanon');
    assert.equal(result.matchedBy, 'town');
    assert.equal(result.correctedZip, '03766');
  } finally {
    await db.close();
  }
});

test("the named town wins over a same-named street in the ZIP's own town", async () => {
  const db = await makeDb();
  try {
    // 03301 has a Franklin St too (Concord, id 71) -- the address says Derry.
    const result = await geocode(db, '38 Franklin St, Derry, NH 03301');
    assert.equal(result.match.id, 72);
    assert.equal(result.correctedZip, '03038');
  } finally {
    await db.close();
  }
});

test("a neighbouring town's segment touching the boundary isn't in the town", async () => {
  const db = await makeDb();
  try {
    // id 74 (ZIP 03784) ends on Lebanon's boundary; Lebanon's own Forest Ave is id 70.
    const result = await geocode(db, '10 Forest Ave, Lebanon, NH 03784');
    assert.equal(result.match.id, 70);
    assert.equal(result.correctedZip, '03766');
  } finally {
    await db.close();
  }
});

test('town and ZIP agreeing gives no correctedZip', async () => {
  const db = await makeDb();
  try {
    const result = await geocode(db, '38 Franklin St, Concord, NH 03301');
    assert.equal(result.match.id, 71);
    assert.equal(result.matchedBy, 'town');
    assert.equal(result.correctedZip, undefined);
  } finally {
    await db.close();
  }
});

test('a town without the street falls back to the ZIP', async () => {
  const db = await makeDb();
  try {
    // Lebanon has no Pequawket Trl; ZIP 04091 (NH row, id 99) does.
    const result = await geocode(db, '150 Pequawket Trl, Lebanon, NH 04091');
    assert.equal(result.match.id, 99);
    assert.equal(result.matchedBy, undefined);
  } finally {
    await db.close();
  }
});

test('a town match needs no ZIP at all', async () => {
  const db = await makeDb();
  try {
    const result = await geocode(db, '10 Forest Ave, Lebanon, NH');
    assert.equal(result.match.id, 70);
    assert.equal(result.correctedZip, undefined);
  } finally {
    await db.close();
  }
});

test('the state picks between same-named towns', async () => {
  const db = await makeDb();
  try {
    const result = await geocode(db, '10 Forest Ave, Lebanon, ME 03301');
    assert.equal(result.match.id, 73);
    assert.equal(result.correctedZip, '04027');
  } finally {
    await db.close();
  }
});

test('same-named towns in two states with the street in both: no guess without a state or matching ZIP', async () => {
  const db = await makeDb();
  try {
    const ambiguous = await matchByStreetAndTown(db, 10, 'Forest Ave', 'Lebanon', null, null, 20);
    assert.equal(ambiguous.result, null);

    const byZip = await matchByStreetAndTown(db, 10, 'Forest Ave', 'Lebanon', null, '04027', 20);
    assert.equal(byZip.result.match.id, 73);
  } finally {
    await db.close();
  }
});

test('the town has the street but not the number: OutOfRangeError naming the town', async () => {
  const db = await makeDb();
  try {
    await assert.rejects(() => geocode(db, '500 Forest Ave, Lebanon, NH 03301'), (err) => {
      assert.ok(err instanceof OutOfRangeError);
      assert.match(err.message, /in Lebanon/);
      return true;
    });
  } finally {
    await db.close();
  }
});

test('without a towns table, matching is ZIP-only as before', async () => {
  const db = await makeDb();
  try {
    await db.query('DROP TABLE towns');
    const result = await geocode(db, '38 Franklin St, Derry, NH 03301');
    assert.equal(result.match.id, 71);
    assert.equal(result.matchedBy, undefined);
  } finally {
    await db.close();
  }
});

test('LLM assist offers the named town\'s streets and re-matches a pick there, not in the wrong ZIP', async () => {
  const savedFetch = global.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let prompt = null;
  global.fetch = async (_url, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
      }),
    };
  };
  const db = await makeDb();
  const usersDb = await makeUsersDb();
  await ensureLlmGeocodeAssistsTable(usersDb);
  try {
    const input = '10 Furest Ave, Lebanon, NH 03301';
    const result = await attemptLlmAssist(db, { usersDb, email: 'demo@example.com' }, parseAddress(input), input, 20);
    assert.match(prompt, /A\. Forest Ave \(ZIP 03766/);
    assert.equal(result.source, 'llm_assisted');
    assert.equal(result.correctedStreet, 'Forest Ave');
    assert.equal(result.match.id, 70);
    assert.equal(result.correctedZip, '03766');
  } finally {
    global.fetch = savedFetch;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
    await db.close();
    await usersDb.close();
  }
});
