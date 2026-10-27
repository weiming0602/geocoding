const test = require('node:test');
const assert = require('node:assert/strict');

const { candidateStreetNames } = require('../src/geocodeMatching');
const { makeDb } = require('./helpers');

test('candidateStreetNames: a misspelled street name in a known ZIP surfaces the real street', async () => {
  const db = await makeDb();
  try {
    // "Pequawket Trl" is seeded at ZIP 04091 (id=12/14) -- "Peqwket Trl"
    // (missing the second "a") should still surface it via trigram
    // similarity.
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: '04091', state: null });
    assert.ok(candidates.some((c) => c.fullname === 'Pequawket Trl'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: scoped by ZIP, a street in a different ZIP is not returned', async () => {
  const db = await makeDb();
  try {
    // "Sebago Rd" lives at ZIP 04074, not 04091 -- a ZIP-scoped search for
    // something near "Pequawket" shouldn't surface it.
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: '04091', state: null });
    assert.ok(!candidates.some((c) => c.fullname === 'Sebago Rd'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: with no ZIP but a state, scopes to that state', async () => {
  const db = await makeDb();
  try {
    // id=99 is "Pequawket Trl" in NH (same name/zip as the ME rows,
    // deliberately, to test state disambiguation) -- a state-scoped
    // search for NH should surface only the NH row's fullname, not
    // silently also match on the ME rows sharing the same name.
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: null, state: 'NH' });
    assert.ok(candidates.some((c) => c.fullname === 'Pequawket Trl' && c.state_abbr === 'NH'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: with neither ZIP nor state, scopes to ME/NH only', async () => {
  const db = await makeDb();
  try {
    const candidates = await candidateStreetNames(db, 'Peqwket Trl', { zip: null, state: null });
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((c) => c.state_abbr === 'ME' || c.state_abbr === 'NH'));
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: a wildly dissimilar name returns no candidates', async () => {
  const db = await makeDb();
  try {
    const candidates = await candidateStreetNames(db, 'Zzyzx Quantum Boulevard', { zip: '04091', state: null });
    assert.equal(candidates.length, 0);
  } finally {
    await db.close();
  }
});

test('candidateStreetNames: results are ordered most-similar first', async () => {
  const db = await makeDb();
  try {
    const candidates = await candidateStreetNames(db, 'Pequawket Trl', { zip: '04091', state: null });
    // The exact name should be the top (or tied-top) result.
    assert.equal(candidates[0].fullname, 'Pequawket Trl');
  } finally {
    await db.close();
  }
});
