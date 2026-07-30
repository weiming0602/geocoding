const test = require('node:test');
const assert = require('node:assert/strict');

const { geocode } = require('../src/geocode');
const { ValidationError, NotFoundError, OutOfRangeError } = require('../src/errors');
const { makeDb } = require('./helpers');

test('odd house number uses the left range and offsets left', () => {
  const db = makeDb();
  const result = geocode(db, '997 Pequawket Trl, Standish, ME 04091', { offsetFeet: 5 });
  assert.equal(result.rangeSide, 'left');
  assert.equal(result.offsetSide, 'left');
  assert.equal(result.match.id, 12);
  db.close();
});

test('even house number uses the right range and offsets right', () => {
  const db = makeDb();
  const result = geocode(db, '984 Pequawket Trl, Standish, ME 04091', { offsetFeet: 5 });
  assert.equal(result.rangeSide, 'right');
  assert.equal(result.offsetSide, 'right');
  assert.equal(result.match.id, 12);
  db.close();
});

test('unmatched street/zip throws NotFoundError', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '997 Nonexistent Rd, Standish, ME 99999'),
    NotFoundError
  );
  db.close();
});

test('street with no address range on the requested side throws OutOfRangeError', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '55 Sebago Rd, Windham, ME 04074'),
    OutOfRangeError
  );
  db.close();
});

test('picks the segment whose range actually contains the number, among several', () => {
  const db = makeDb();
  const result = geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  assert.equal(result.match.id, 12);

  const other = geocode(db, '721 Pequawket Trl, Standish, ME 04091', { offsetFeet: 0 });
  assert.equal(other.match.id, 14);
  db.close();
});

test('number outside the matched range throws OutOfRangeError', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '57 Pequawket Trl, Standish, ME 04091'),
    OutOfRangeError
  );
  db.close();
});

test('invalid address throws ValidationError', () => {
  const db = makeDb();
  assert.throws(() => geocode(db, ''), ValidationError);
  db.close();
});
