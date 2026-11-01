const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureLlmGeocodeAssistsTable, logLlmGeocodeAssist } = require('../src/llmGeocodeAssists');
const { makeUsersDb } = require('./helpers');

const SAMPLE_CANDIDATES = [
  { fullname: 'Pequawket Trl', zipl: '04091', zipr: '04091', state_abbr: 'ME' },
];

test('ensureLlmGeocodeAssistsTable is idempotent -- safe to call twice', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await ensureLlmGeocodeAssistsTable(db);
    const { rows } = await db.query('SELECT count(*) FROM llm_geocode_assists');
    assert.equal(rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test('logLlmGeocodeAssist: a successful attempt records picked + succeeded true + no failure_reason', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: '997 Peqwket Trl, 04091',
      candidates: SAMPLE_CANDIDATES,
      picked: 'Pequawket Trl (ZIP 04091, ME)',
      succeeded: true,
      failureReason: null,
    });
    const { rows } = await db.query('SELECT * FROM llm_geocode_assists');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, 'demo@example.com');
    assert.equal(rows[0].original_input, '997 Peqwket Trl, 04091');
    assert.deepEqual(rows[0].candidates_considered, SAMPLE_CANDIDATES);
    assert.equal(rows[0].picked, 'Pequawket Trl (ZIP 04091, ME)');
    assert.equal(rows[0].succeeded, true);
    assert.equal(rows[0].failure_reason, null);
    assert.ok(rows[0].created_at);
  } finally {
    await db.close();
  }
});

test('logLlmGeocodeAssist: a failed attempt (none fit) records picked null + succeeded false + failure_reason', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: '123 Totally Different St, 04091',
      candidates: SAMPLE_CANDIDATES,
      picked: null,
      succeeded: false,
      failureReason: 'none_fit',
    });
    const { rows } = await db.query('SELECT * FROM llm_geocode_assists');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].picked, null);
    assert.equal(rows[0].succeeded, false);
    assert.equal(rows[0].failure_reason, 'none_fit');
  } finally {
    await db.close();
  }
});

test('logLlmGeocodeAssist: multiple attempts from the same email all persist independently', async () => {
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: 'first attempt',
      candidates: SAMPLE_CANDIDATES,
      picked: null,
      succeeded: false,
      failureReason: 'llm_error',
    });
    await logLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: 'second attempt',
      candidates: SAMPLE_CANDIDATES,
      picked: 'Pequawket Trl (ZIP 04091, ME)',
      succeeded: true,
      failureReason: null,
    });
    const { rows } = await db.query('SELECT original_input FROM llm_geocode_assists ORDER BY id');
    assert.deepEqual(rows.map((r) => r.original_input), ['first attempt', 'second attempt']);
  } finally {
    await db.close();
  }
});

test('claimLlmGeocodeAssist: concurrent claims never exceed the daily cap', async () => {
  const { claimLlmGeocodeAssist } = require('../src/llmGeocodeAssists');
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimLlmGeocodeAssist(db, {
          email: 'demo@example.com',
          originalInput: '997 Peqwket Trl, 04091',
          candidates: SAMPLE_CANDIDATES,
          context: 'batch',
          dailyCap: 3,
        })
      )
    );
    assert.equal(ids.filter(Boolean).length, 3);
    const { rows } = await db.query("SELECT count(*)::int AS n, min(failure_reason) AS reason FROM llm_geocode_assists");
    assert.deepEqual(rows[0], { n: 3, reason: 'in_progress' });
  } finally {
    await db.close();
  }
});

test('finishLlmGeocodeAssist fills in a claimed attempt', async () => {
  const { claimLlmGeocodeAssist, finishLlmGeocodeAssist } = require('../src/llmGeocodeAssists');
  const db = await makeUsersDb();
  try {
    await ensureLlmGeocodeAssistsTable(db);
    const id = await claimLlmGeocodeAssist(db, {
      email: 'demo@example.com',
      originalInput: '997 Peqwket Trl, 04091',
      candidates: SAMPLE_CANDIDATES,
      dailyCap: 50,
    });
    await finishLlmGeocodeAssist(db, id, { picked: 'Pequawket Trl (ZIP 04091, ME)', succeeded: true, failureReason: null });
    const { rows } = await db.query('SELECT picked, succeeded, failure_reason, context FROM llm_geocode_assists');
    assert.deepEqual(rows, [
      { picked: 'Pequawket Trl (ZIP 04091, ME)', succeeded: true, failure_reason: null, context: 'single' },
    ]);
  } finally {
    await db.close();
  }
});
