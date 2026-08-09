const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAddress } = require('../src/parseAddress');
const { ValidationError } = require('../src/errors');

test('parses a comma-separated address with a 2-letter state', () => {
  const result = parseAddress('996 Pequawket Trl, Standish, ME 04091');
  assert.deepEqual(result, {
    number: 996,
    streetName: 'Pequawket Trl',
    zip: '04091',
    state: 'ME',
    town: 'Standish',
  });
});

test('parses a comma-separated address with a full state name', () => {
  const result = parseAddress('996 Pequawket Trl, Standish, Maine 04091');
  assert.deepEqual(result, {
    number: 996,
    streetName: 'Pequawket Trl',
    zip: '04091',
    state: 'Maine',
    town: 'Standish',
  });
});

test('parses an address with no commas', () => {
  const result = parseAddress('996 Pequawket Trl ME 04091');
  assert.deepEqual(result, {
    number: 996,
    streetName: 'Pequawket Trl',
    zip: '04091',
    state: 'ME',
    town: null,
  });
});

test('parses an address with no commas and no trailing state code', () => {
  const result = parseAddress('996 Pequawket Trl 04091');
  assert.deepEqual(result, {
    number: 996,
    streetName: 'Pequawket Trl',
    zip: '04091',
    state: null,
    town: null,
  });
});

test('a street suffix that looks like a 2-letter code is not mistaken for a state', () => {
  const result = parseAddress('123 Main Rd 04001');
  assert.deepEqual(result, {
    number: 123,
    streetName: 'Main Rd',
    zip: '04001',
    state: null,
    town: null,
  });
});

test('other common 2-letter street suffixes are not mistaken for a state either', () => {
  for (const suffix of ['St', 'Ln', 'Dr', 'Cv', 'Pl', 'Sq']) {
    const result = parseAddress(`123 Main ${suffix} 04001`);
    assert.equal(result.streetName, `Main ${suffix}`, `suffix ${suffix}`);
    assert.equal(result.state, null, `suffix ${suffix}`);
  }
});

test('a real 2-letter state code with no comma still parses as state', () => {
  const result = parseAddress('123 Main Rd NH 04001');
  assert.deepEqual(result, {
    number: 123,
    streetName: 'Main Rd',
    zip: '04001',
    state: 'NH',
    town: null,
  });
});

test('a single comma before the state (no separate town) parses with town null', () => {
  const result = parseAddress('996 Pequawket Trl, ME 04091');
  assert.equal(result.town, null);
});

// Regression test: "Street, Town, State, ZIP" (a trailing comma before
// the ZIP, in addition to the usual street/town split) used to swallow
// "Town, State" whole into `town` and leave `state` empty, since the
// comma right before the ZIP looked identical to the normal "Street,
// Town, <ZIP with no state>" shape. Broke Maine E911 address-point
// matching (town must match exactly) for anyone typing a full state name
// with its own trailing comma -- see geocode.js's matchAddressPoint.
test('a trailing comma before the ZIP does not swallow the state into town', () => {
  const result = parseAddress('13 Deerfield Dr, Brunswick, Maine, 04011');
  assert.deepEqual(result, {
    number: 13,
    streetName: 'Deerfield Dr',
    zip: '04011',
    state: 'Maine',
    town: 'Brunswick',
  });
});

test('a trailing comma before the ZIP with a 2-letter state also parses correctly', () => {
  const result = parseAddress('13 Deerfield Dr, Brunswick, ME, 04011');
  assert.deepEqual(result, {
    number: 13,
    streetName: 'Deerfield Dr',
    zip: '04011',
    state: 'ME',
    town: 'Brunswick',
  });
});

// "Street, Town," with nothing else before the ZIP (only 2 commas, not
// 3) is the ordinary no-state shape and must still parse with town only
// -- the fix above must not touch this case.
test('a trailing comma with no state segment still parses as town only (unchanged)', () => {
  const result = parseAddress('13 Deerfield Dr, Brunswick, 04011');
  assert.deepEqual(result, {
    number: 13,
    streetName: 'Deerfield Dr',
    zip: '04011',
    state: null,
    town: 'Brunswick',
  });
});

test('rejects a non-string address', () => {
  assert.throws(() => parseAddress(42), ValidationError);
});

test('rejects an empty address', () => {
  assert.throws(() => parseAddress('   '), ValidationError);
});

test('rejects an address with no leading house number', () => {
  assert.throws(() => parseAddress('Pequawket Trl, Standish, ME 04091'), ValidationError);
});

test('rejects an address with no ZIP code', () => {
  assert.throws(() => parseAddress('996 Pequawket Trl, Standish, ME'), ValidationError);
});

test('rejects an overly long address', () => {
  assert.throws(() => parseAddress('1 ' + 'A'.repeat(300) + ' 04091'), ValidationError);
});
