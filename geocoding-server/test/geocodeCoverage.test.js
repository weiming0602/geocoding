const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyCoverage, isPlausiblyInCoverageArea } = require('../src/geocodeCoverage');
const { makeDb } = require('./helpers');

test('classifyCoverage: 2-letter ME state code is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'ME' }), 'in');
});

test('classifyCoverage: 2-letter NH state code is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'NH' }), 'in');
});

test('classifyCoverage: full state name "Maine" is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'Maine' }), 'in');
});

test('classifyCoverage: full state name "New Hampshire" is in range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'New Hampshire' }), 'in');
});

test('classifyCoverage: an explicit non-ME/NH 2-letter state code is out of range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'TX' }), 'out');
});

test('classifyCoverage: an explicit non-ME/NH full state name is out of range', () => {
  assert.equal(classifyCoverage({ zip: null, state: 'Texas' }), 'out');
});

test('classifyCoverage: a ZIP in the ME prefix range (039-049) is in range when no state given', () => {
  assert.equal(classifyCoverage({ zip: '04091', state: null }), 'in');
});

test('classifyCoverage: a ZIP in the NH prefix range (030-038) is in range when no state given', () => {
  assert.equal(classifyCoverage({ zip: '03301', state: null }), 'in');
});

test('classifyCoverage: a ZIP outside the ME/NH prefix ranges is out of range when no state given', () => {
  assert.equal(classifyCoverage({ zip: '78701', state: null }), 'out'); // Austin, TX
});

test('classifyCoverage: state takes priority over a contradicting ZIP', () => {
  // Deliberately inconsistent input -- state is the stronger, more explicit signal.
  assert.equal(classifyCoverage({ zip: '78701', state: 'ME' }), 'in');
});

test('classifyCoverage: neither state nor zip is inconclusive', () => {
  assert.equal(classifyCoverage({ zip: null, state: null }), 'inconclusive');
});

test('isPlausiblyInCoverageArea: returns true immediately for an in-range ZIP without touching the DB', async () => {
  const db = { query: () => { throw new Error('should not be called'); } };
  const result = await isPlausiblyInCoverageArea(db, { zip: '04091', state: null, town: null });
  assert.equal(result, true);
});

test('isPlausiblyInCoverageArea: returns false immediately for an explicit out-of-range state without touching the DB', async () => {
  const db = { query: () => { throw new Error('should not be called'); } };
  const result = await isPlausiblyInCoverageArea(db, { zip: null, state: 'TX', town: null });
  assert.equal(result, false);
});

test('isPlausiblyInCoverageArea: inconclusive + a real Maine town still falls through to true (no DB-backed town check anymore -- see geocodeCoverage.js)', async () => {
  const db = await makeDb();
  try {
    // "Standish" is seeded by seedFixtureStreets() via the test-uid-2 address_points row,
    // but isPlausiblyInCoverageArea no longer queries address_points at all -- a non-match
    // there could never safely mean "out" (NH has zero address_points coverage), so the
    // town-matching query was dead weight and was removed.
    const result = await isPlausiblyInCoverageArea(db, { zip: null, state: null, town: 'Standish' });
    assert.equal(result, true);
  } finally {
    await db.close();
  }
});

test('isPlausiblyInCoverageArea: inconclusive + unrecognized town falls through to true anyway (false negatives cost more than the rare wasted LLM call)', async () => {
  const db = await makeDb();
  try {
    const result = await isPlausiblyInCoverageArea(db, { zip: null, state: null, town: 'Nowhereville' });
    assert.equal(result, true);
  } finally {
    await db.close();
  }
});

test('isPlausiblyInCoverageArea: inconclusive + no town at all also falls through to true', async () => {
  const db = await makeDb();
  try {
    const result = await isPlausiblyInCoverageArea(db, { zip: null, state: null, town: null });
    assert.equal(result, true);
  } finally {
    await db.close();
  }
});
