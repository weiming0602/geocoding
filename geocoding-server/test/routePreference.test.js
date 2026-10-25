const test = require('node:test');
const assert = require('node:assert/strict');

const { rankRoutes, relevantWeightedPoints, weightFactor, distanceToPolylineMeters } = require('../src/routePreference');

// Near the equator, where metersPerDegree is 111320 for both axes.
const M = 1 / 111320; // one meter in degrees

function route(distanceMeters, coordinates) {
  return { geometry: { type: 'LineString', coordinates }, distanceMeters };
}
const DIRECT = route(2000, [[0, 0], [2000 * M, 0]]);
// A detour 200 m north: ~2400 m long.
const NORTH = route(2400, [[0, 0], [0, 200 * M], [2000 * M, 200 * M], [2000 * M, 0]]);
const POINT_ON_NORTH = { latitude: 200 * M, longitude: 1000 * M, weight: 5 };

test('weightFactor: heaviest point gets the biggest discount, a weightless one the smallest', () => {
  assert.equal(weightFactor(10, 10), 0.3);
  assert.equal(weightFactor(0, 10), 0.7);
  assert.ok(Math.abs(weightFactor(5, 10) - 0.5) < 1e-9);
  assert.equal(weightFactor(0, 0), 0.3);
});

test('distanceToPolylineMeters measures to the nearest segment, not just vertices', () => {
  assert.ok(Math.abs(distanceToPolylineMeters({ latitude: 30 * M, longitude: 1000 * M }, DIRECT.geometry.coordinates) - 30) < 0.5);
});

test('rankRoutes prefers a somewhat longer route that passes a weighted point, and flags it', () => {
  const [first, second] = rankRoutes([DIRECT, NORTH], [POINT_ON_NORTH], 3);
  assert.equal(first.distanceMeters, 2400);
  assert.equal(first.usesWeightedPoints, true);
  assert.equal(first.weightedPointsPassed, 1);
  assert.equal(second.distanceMeters, 2000);
  assert.equal(second.usesWeightedPoints, false);
});

test('rankRoutes still picks the shorter route when the weighted one is more than ~3x longer', () => {
  const huge = route(7000, NORTH.geometry.coordinates);
  const [first] = rankRoutes([DIRECT, huge], [POINT_ON_NORTH], 3);
  assert.equal(first.distanceMeters, 2000);
});

test('rankRoutes with no weighted points orders by distance and flags nothing', () => {
  const ranked = rankRoutes([NORTH, DIRECT], [], 3);
  assert.deepEqual(ranked.map((r) => r.distanceMeters), [2000, 2400]);
  assert.ok(ranked.every((r) => r.usesWeightedPoints === false));
});

test('rankRoutes drops duplicate geometry and honors the limit', () => {
  const ranked = rankRoutes([DIRECT, { ...DIRECT }, NORTH], [], 1);
  assert.equal(ranked.length, 1);
  assert.equal(rankRoutes([DIRECT, { ...DIRECT }, NORTH], [], 5).length, 2);
});

test('relevantWeightedPoints keeps points roughly on the way, heaviest first, not at the ends', () => {
  const start = { latitude: 0, longitude: 0 };
  const end = { latitude: 0, longitude: 2000 * M };
  const onTheWay = { latitude: 200 * M, longitude: 1000 * M, weight: 2 };
  const heavier = { latitude: -300 * M, longitude: 900 * M, weight: 9 };
  const farOff = { latitude: 5000 * M, longitude: 1000 * M, weight: 50 }; // via it is ~5x the direct distance
  const atStart = { latitude: 20 * M, longitude: 0, weight: 99 };
  assert.deepEqual(relevantWeightedPoints([onTheWay, farOff, atStart, heavier], start, end), [heavier, onTheWay]);
});
