const test = require('node:test');
const assert = require('node:assert/strict');

const { expandStreetSuffix, abbreviateStreetSuffix } = require('../src/streetSuffixes');

test('expandStreetSuffix expands a trailing abbreviation', () => {
  assert.equal(expandStreetSuffix('Deerfield Dr'), 'Deerfield Drive');
});

test('expandStreetSuffix leaves an already-expanded name unchanged', () => {
  assert.equal(expandStreetSuffix('Deerfield Drive'), 'Deerfield Drive');
});

test('abbreviateStreetSuffix abbreviates a trailing full suffix name', () => {
  assert.equal(abbreviateStreetSuffix('Pequawket Trail'), 'Pequawket Trl');
});

test('abbreviateStreetSuffix is case-insensitive on the suffix word', () => {
  assert.equal(abbreviateStreetSuffix('Pequawket TRAIL'), 'Pequawket Trl');
  assert.equal(abbreviateStreetSuffix('Pequawket trail'), 'Pequawket Trl');
});

test('abbreviateStreetSuffix leaves an already-abbreviated name unchanged', () => {
  assert.equal(abbreviateStreetSuffix('Pequawket Trl'), 'Pequawket Trl');
});

test('abbreviateStreetSuffix leaves an unrecognized trailing word unchanged', () => {
  assert.equal(abbreviateStreetSuffix('Main Alley'), 'Main Alley');
});

test('abbreviateStreetSuffix covers every known expansion, round-tripping back to its abbreviation', () => {
  const cases = [
    ['Avenue', 'Ave'],
    ['Boulevard', 'Blvd'],
    ['Circle', 'Cir'],
    ['Court', 'Ct'],
    ['Drive', 'Dr'],
    ['Highway', 'Hwy'],
    ['Lane', 'Ln'],
    ['Parkway', 'Pkwy'],
    ['Place', 'Pl'],
    ['Plaza', 'Plz'],
    ['Road', 'Rd'],
    ['Square', 'Sq'],
    ['Street', 'St'],
    ['Terrace', 'Ter'],
    ['Trail', 'Trl'],
    ['Way', 'Way'],
  ];
  for (const [full, abbr] of cases) {
    assert.equal(abbreviateStreetSuffix(`Test ${full}`), `Test ${abbr}`, `full: ${full}`);
  }
});
