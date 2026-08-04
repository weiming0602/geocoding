const test = require('node:test');
const assert = require('node:assert/strict');

const { geocode } = require('../src/geocode');
const { ValidationError, NotFoundError, OutOfRangeError } = require('../src/errors');
const { makeDb } = require('./helpers');

test('odd house number uses the left range and offsets left', async () => {
  const db = await makeDb();
  const result = await geocode(db, '997 Pequawket Trl, Standish, ME 04091', { offsetFeet: 5 });
  assert.equal(result.rangeSide, 'left');
  assert.equal(result.offsetSide, 'left');
  assert.equal(result.match.id, 12);
  await db.close();
});

test('even house number uses the right range and offsets right', async () => {
  const db = await makeDb();
  const result = await geocode(db, '984 Pequawket Trl, Standish, ME 04091', { offsetFeet: 5 });
  assert.equal(result.rangeSide, 'right');
  assert.equal(result.offsetSide, 'right');
  assert.equal(result.match.id, 12);
  await db.close();
});

test('unmatched street/zip throws NotFoundError', async () => {
  const db = await makeDb();
  await assert.rejects(
    () => geocode(db, '997 Nonexistent Rd, Standish, ME 99999'),
    NotFoundError
  );
  await db.close();
});

test('street with no address range on the requested side throws OutOfRangeError', async () => {
  const db = await makeDb();
  await assert.rejects(
    () => geocode(db, '55 Sebago Rd, Windham, ME 04074'),
    OutOfRangeError
  );
  await db.close();
});

test('picks the segment whose range actually contains the number, among several', async () => {
  const db = await makeDb();
  const result = await geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  assert.equal(result.match.id, 12);

  const other = await geocode(db, '721 Pequawket Trl, Standish, ME 04091', { offsetFeet: 0 });
  assert.equal(other.match.id, 14);
  await db.close();
});

test('number outside the matched range throws OutOfRangeError', async () => {
  const db = await makeDb();
  await assert.rejects(
    () => geocode(db, '57 Pequawket Trl, Standish, ME 04091'),
    OutOfRangeError
  );
  await db.close();
});

test('invalid address throws ValidationError', async () => {
  const db = await makeDb();
  await assert.rejects(() => geocode(db, ''), ValidationError);
  await db.close();
});

test('a 2-letter state disambiguates via state_abbr', async () => {
  const db = await makeDb();
  const result = await geocode(db, '150 Pequawket Trl, Somewhere, NH 04091');
  assert.equal(result.match.id, 99);
  assert.equal(result.match.state_abbr, 'NH');
  assert.equal(result.match.state, undefined);
  await db.close();
});

test('a full state name disambiguates via state', async () => {
  const db = await makeDb();
  const result = await geocode(db, '150 Pequawket Trl, Somewhere, New Hampshire 04091');
  assert.equal(result.match.id, 99);
  assert.equal(result.match.state, 'New Hampshire');
  assert.equal(result.match.state_abbr, undefined);
  await db.close();
});

test('no state parsed means match has neither state field', async () => {
  const db = await makeDb();
  const result = await geocode(db, '997 Pequawket Trl 04091');
  assert.equal(result.match.state, undefined);
  assert.equal(result.match.state_abbr, undefined);
  await db.close();
});

test('a different 2-letter state matches the Maine rows, not New Hampshire', async () => {
  const db = await makeDb();
  const result = await geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  assert.equal(result.match.id, 12);
  await db.close();
});

test('no state in the address searches across all states (fullname+zip only)', async () => {
  const db = await makeDb();
  // No comma and no trailing 2-letter code, so parseAddress can't isolate
  // a state; candidates come from every state sharing this fullname+zip,
  // and the range check alone picks the right segment (997 only fits id=12).
  const result = await geocode(db, '997 Pequawket Trl 04091');
  assert.equal(result.match.id, 12);
  await db.close();
});

// Greely Rd (id=50) spans a ZIP boundary: zipl='04021' on the odd/left
// side (201-291), zipr='04097' on the even/right side (200-292).
test('odd house number matches on zipl, not zipr', async () => {
  const db = await makeDb();
  const result = await geocode(db, '251 Greely Rd, Anywhere, ME 04021');
  assert.equal(result.match.id, 50);
  assert.equal(result.rangeSide, 'left');
  await db.close();
});

test('odd house number with the right-side ZIP does not match', async () => {
  const db = await makeDb();
  await assert.rejects(
    () => geocode(db, '251 Greely Rd, Anywhere, ME 04097'),
    NotFoundError
  );
  await db.close();
});

test('even house number matches on zipr, not zipl', async () => {
  const db = await makeDb();
  const result = await geocode(db, '250 Greely Rd, Anywhere, ME 04097');
  assert.equal(result.match.id, 50);
  assert.equal(result.rangeSide, 'right');
  await db.close();
});

test('even house number with the left-side ZIP does not match', async () => {
  const db = await makeDb();
  await assert.rejects(
    () => geocode(db, '250 Greely Rd, Anywhere, ME 04021'),
    NotFoundError
  );
  await db.close();
});

// TLID 78056932 (id=12) is registered under two real TIGER names:
// "Pequawket Trl" (primary) and "State Rte 113" (alternate).
test('a real alternate name (State Rte 113) resolves to the same street as its primary name', async () => {
  const db = await makeDb();
  const byPrimary = await geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  const byAlias = await geocode(db, '997 State Rte 113, Standish, ME 04091');

  assert.equal(byAlias.match.id, 12);
  assert.equal(byAlias.match.id, byPrimary.match.id);
  assert.deepEqual(byAlias.coordinates, byPrimary.coordinates);
  // The response still reports the row's actual primary fullname, not
  // whatever alias the caller happened to search by.
  assert.equal(byAlias.match.fullname, 'Pequawket Trl');
  await db.close();
});

test('an alternate name also respects the LIKE fallback for partial matches', async () => {
  const db = await makeDb();
  const result = await geocode(db, '997 State Rte, Standish, ME 04091');
  assert.equal(result.match.id, 12);
  await db.close();
});

test('a name with no street_names entry at all does not match', async () => {
  const db = await makeDb();
  await assert.rejects(
    () => geocode(db, '997 Totally Unregistered Rd, Standish, ME 04091'),
    NotFoundError
  );
  await db.close();
});

test('an exact address_points match is preferred over interpolation', async () => {
  const db = await makeDb();
  const result = await geocode(db, '42 Test Point Lane, Testville, ME 00000');
  assert.equal(result.source, 'address_point');
  assert.deepEqual(result.coordinates, { latitude: 43.5, longitude: -70.5 });
  await db.close();
});

test('address_points matching expands a USPS suffix abbreviation (Ln -> Lane)', async () => {
  const db = await makeDb();
  const result = await geocode(db, '42 Test Point Ln, Testville, ME 00000');
  assert.equal(result.source, 'address_point');
  await db.close();
});

test('address_points matching is scoped by town, not ZIP', async () => {
  const db = await makeDb();
  // Wrong town, right street/number: must not match the Testville point --
  // and since there's no such TIGER street either, this has nowhere to
  // fall back to.
  await assert.rejects(
    () => geocode(db, '42 Test Point Lane, Nowhereville, ME 00000'),
    NotFoundError
  );
  await db.close();
});
