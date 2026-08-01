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

test('a 2-letter state disambiguates via state_abbr', () => {
  const db = makeDb();
  const result = geocode(db, '150 Pequawket Trl, Somewhere, NH 04091');
  assert.equal(result.match.id, 99);
  assert.equal(result.match.state_abbr, 'NH');
  assert.equal(result.match.state, undefined);
  db.close();
});

test('a full state name disambiguates via state', () => {
  const db = makeDb();
  const result = geocode(db, '150 Pequawket Trl, Somewhere, New Hampshire 04091');
  assert.equal(result.match.id, 99);
  assert.equal(result.match.state, 'New Hampshire');
  assert.equal(result.match.state_abbr, undefined);
  db.close();
});

test('no state parsed means match has neither state field', () => {
  const db = makeDb();
  const result = geocode(db, '997 Pequawket Trl 04091');
  assert.equal(result.match.state, undefined);
  assert.equal(result.match.state_abbr, undefined);
  db.close();
});

test('a different 2-letter state matches the Maine rows, not New Hampshire', () => {
  const db = makeDb();
  const result = geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  assert.equal(result.match.id, 12);
  db.close();
});

test('no state in the address searches across all states (fullname+zip only)', () => {
  const db = makeDb();
  // No comma and no trailing 2-letter code, so parseAddress can't isolate
  // a state; candidates come from every state sharing this fullname+zip,
  // and the range check alone picks the right segment (997 only fits id=12).
  const result = geocode(db, '997 Pequawket Trl 04091');
  assert.equal(result.match.id, 12);
  db.close();
});

// Greely Rd (id=50) spans a ZIP boundary: zipl='04021' on the odd/left
// side (201-291), zipr='04097' on the even/right side (200-292).
test('odd house number matches on zipl, not zipr', () => {
  const db = makeDb();
  const result = geocode(db, '251 Greely Rd, Anywhere, ME 04021');
  assert.equal(result.match.id, 50);
  assert.equal(result.rangeSide, 'left');
  db.close();
});

test('odd house number with the right-side ZIP does not match', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '251 Greely Rd, Anywhere, ME 04097'),
    NotFoundError
  );
  db.close();
});

test('even house number matches on zipr, not zipl', () => {
  const db = makeDb();
  const result = geocode(db, '250 Greely Rd, Anywhere, ME 04097');
  assert.equal(result.match.id, 50);
  assert.equal(result.rangeSide, 'right');
  db.close();
});

test('even house number with the left-side ZIP does not match', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '250 Greely Rd, Anywhere, ME 04021'),
    NotFoundError
  );
  db.close();
});

// TLID 78056932 (id=12) is registered under two real TIGER names:
// "Pequawket Trl" (primary) and "State Rte 113" (alternate).
test('a real alternate name (State Rte 113) resolves to the same street as its primary name', () => {
  const db = makeDb();
  const byPrimary = geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  const byAlias = geocode(db, '997 State Rte 113, Standish, ME 04091');

  assert.equal(byAlias.match.id, 12);
  assert.equal(byAlias.match.id, byPrimary.match.id);
  assert.deepEqual(byAlias.coordinates, byPrimary.coordinates);
  // The response still reports the row's actual primary fullname, not
  // whatever alias the caller happened to search by.
  assert.equal(byAlias.match.fullname, 'Pequawket Trl');
  db.close();
});

test('an alternate name also respects the LIKE fallback for partial matches', () => {
  const db = makeDb();
  const result = geocode(db, '997 State Rte, Standish, ME 04091');
  assert.equal(result.match.id, 12);
  db.close();
});

test('a name with no street_names entry at all does not match', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '997 Totally Unregistered Rd, Standish, ME 04091'),
    NotFoundError
  );
  db.close();
});
