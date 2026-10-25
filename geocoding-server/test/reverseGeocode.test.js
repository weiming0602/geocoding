const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reverseGeocode,
  closestPointOnLine,
  closestPointOnSegment,
  roundToRangeParity,
} = require('../src/reverseGeocode');
const { ValidationError, NotFoundError } = require('../src/errors');
const { geocode } = require('../src/geocode');
const { makeDb } = require('./helpers');

test('closestPointOnSegment finds the perpendicular foot when it falls within the segment', () => {
  const result = closestPointOnSegment(1, 1, 0, 0, 2, 0);
  assert.equal(result.t, 0.5);
  assert.equal(result.x, 1);
  assert.equal(result.y, 0);
  assert.equal(result.distance, 1);
});

test('closestPointOnSegment clamps to an endpoint when the projection falls outside', () => {
  const result = closestPointOnSegment(-5, 3, 0, 0, 2, 0);
  assert.equal(result.t, 0);
  assert.equal(result.x, 0);
  assert.equal(result.y, 0);
});

test('closestPointOnLine identifies left vs right side correctly', () => {
  // A north-pointing line; a point to the west is "left", east is "right".
  const points = [[-70.0, 43.0], [-70.0, 43.01]];
  const west = closestPointOnLine(points, -70.001, 43.005);
  const east = closestPointOnLine(points, -69.999, 43.005);
  assert.equal(west.side, 'left');
  assert.equal(east.side, 'right');
});

test('roundToRangeParity picks the nearest integer with the parity of the side\'s own range', () => {
  assert.equal(roundToRangeParity(10.4, 1, 99), 11); // odd range -> nearest odd
  assert.equal(roundToRangeParity(10.4, 2, 98), 10); // even range -> nearest even
  assert.equal(roundToRangeParity(10.9, 98, 2), 10); // rounds to 11 (odd); 10 is the nearer even
  assert.equal(roundToRangeParity(10.6, 1, 98), 11); // mixed-parity range makes no claim -> plain rounding
});

// Round trips through forward geocoding rather than hard-coded
// coordinates, so these exercise the same side choice both directions.
test('reverseGeocode round-trips a forward-geocoded point (odd range on the left)', async () => {
  const db = await makeDb();
  const forward = await geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  const result = await reverseGeocode(db, forward.coordinates.latitude, forward.coordinates.longitude);
  assert.equal(result.match.id, 12);
  assert.equal(result.side, 'left');
  assert.equal(result.number, 997);
  assert.ok(result.distanceMeters < 10);
  await db.close();
});

test('reverseGeocode round-trips a forward-geocoded point (even range on the right)', async () => {
  const db = await makeDb();
  const forward = await geocode(db, '984 Pequawket Trl, Standish, ME 04091');
  const result = await reverseGeocode(db, forward.coordinates.latitude, forward.coordinates.longitude);
  assert.equal(result.match.id, 12);
  assert.equal(result.side, 'right');
  assert.equal(result.number, 984);
  await db.close();
});

test('reverseGeocode returns an odd number on a right side whose range is odd', async () => {
  const db = await makeDb();
  const forward = await geocode(db, '11 Grove St, Freeport, ME 04032');
  const result = await reverseGeocode(db, forward.coordinates.latitude, forward.coordinates.longitude);
  assert.equal(result.match.id, 60);
  assert.equal(result.side, 'right');
  assert.equal(result.number, 11);
  await db.close();
});

test('reverseGeocode rejects invalid coordinates', async () => {
  const db = await makeDb();
  await assert.rejects(() => reverseGeocode(db, 200, -70), ValidationError);
  await assert.rejects(() => reverseGeocode(db, 43, -200), ValidationError);
  await assert.rejects(() => reverseGeocode(db, 'a', -70), ValidationError);
  await db.close();
});

test('reverseGeocode throws NotFoundError far from any street in the fixture', async () => {
  const db = await makeDb();
  await assert.rejects(() => reverseGeocode(db, 0, 0), NotFoundError);
  await db.close();
});
