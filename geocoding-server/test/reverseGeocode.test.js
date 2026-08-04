const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reverseGeocode,
  closestPointOnLine,
  closestPointOnSegment,
  roundToSideParity,
} = require('../src/reverseGeocode');
const { ValidationError, NotFoundError } = require('../src/errors');
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

test('roundToSideParity picks the nearest integer of the required parity', () => {
  assert.equal(roundToSideParity(10.4, 'left'), 11); // nearest odd
  assert.equal(roundToSideParity(10.4, 'right'), 10); // nearest even
  assert.equal(roundToSideParity(10.9, 'right'), 10); // rounds to 11 (odd); 10 is the nearer even
});

test('reverseGeocode round-trips a known forward-geocoded point (odd/left)', async () => {
  const db = await makeDb();
  // From the interpolate.js session: 997 Pequawket Trl -> (43.834390719401604, -70.77854947339969)
  const result = await reverseGeocode(db, 43.834390719401604, -70.77854947339969);
  assert.equal(result.match.id, 12);
  assert.equal(result.side, 'left');
  assert.equal(result.number, 997);
  assert.ok(result.distanceMeters < 10);
  await db.close();
});

test('reverseGeocode round-trips a known forward-geocoded point (even/right)', async () => {
  const db = await makeDb();
  // 984 Pequawket Trl -> (43.83413979730152, -70.77834399095207)
  const result = await reverseGeocode(db, 43.83413979730152, -70.77834399095207);
  assert.equal(result.match.id, 12);
  assert.equal(result.side, 'right');
  assert.equal(result.number, 984);
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
