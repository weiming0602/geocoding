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
