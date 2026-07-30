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
  });
});

test('parses a comma-separated address with a full state name', () => {
  const result = parseAddress('996 Pequawket Trl, Standish, Maine 04091');
  assert.deepEqual(result, {
    number: 996,
    streetName: 'Pequawket Trl',
    zip: '04091',
    state: 'Maine',
  });
});

test('parses an address with no commas', () => {
  const result = parseAddress('996 Pequawket Trl ME 04091');
  assert.deepEqual(result, {
    number: 996,
    streetName: 'Pequawket Trl',
    zip: '04091',
    state: 'ME',
  });
});

test('parses an address with no commas and no trailing state code', () => {
  const result = parseAddress('996 Pequawket Trl 04091');
  assert.deepEqual(result, {
    number: 996,
    streetName: 'Pequawket Trl',
    zip: '04091',
    state: null,
  });
});

test('a street suffix that looks like a 2-letter code is not mistaken for a state', () => {
  const result = parseAddress('123 Main Rd 04001');
  assert.deepEqual(result, {
    number: 123,
    streetName: 'Main Rd',
    zip: '04001',
    state: null,
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
