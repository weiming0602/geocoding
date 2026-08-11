const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLinestring, interpolateAlongLine } = require('../src/interpolate');

test('parseLinestring parses points', () => {
  const points = parseLinestring('LINESTRING (-70.1 43.1, -70.2 43.2, -70.3 43.3)');
  assert.deepEqual(points, [
    [-70.1, 43.1],
    [-70.2, 43.2],
    [-70.3, 43.3],
  ]);
});

test('interpolateAlongLine finds the midpoint', () => {
  const [x, y] = interpolateAlongLine([[0, 0], [0, 2]], 0.5);
  assert.ok(Math.abs(x - 0) < 1e-9);
  assert.ok(Math.abs(y - 1) < 1e-9);
});

test('offset right of a northward line pushes east', () => {
  const [x, y] = interpolateAlongLine([[0, 0], [0, 1]], 0.5, 10, 'right');
  assert.ok(x > 0);
  assert.ok(Math.abs(y - 0.5) < 1e-6);
});

test('offset left of a northward line pushes west', () => {
  const [x, y] = interpolateAlongLine([[0, 0], [0, 1]], 0.5, 10, 'left');
  assert.ok(x < 0);
  assert.ok(Math.abs(y - 0.5) < 1e-6);
});

test('a duplicate vertex mid-line does not make the walk snap early', () => {
  // Duplicate point at index 1/2 (a zero-length segment), total length 2.
  // 75% of the way along should be 1.5 units in, past the duplicate --
  // not snapped to it just because the walk passed through it first.
  const points = [[0, 0], [1, 0], [1, 0], [2, 0]];
  const [x, y] = interpolateAlongLine(points, 0.75, 0);
  assert.ok(Math.abs(x - 1.5) < 1e-9, `expected x ~= 1.5, got ${x}`);
  assert.equal(y, 0);
});

test('a duplicate vertex exactly at the target still lands on it', () => {
  const points = [[0, 0], [1, 0], [1, 0], [2, 0]];
  const [x, y] = interpolateAlongLine(points, 0.5, 0);
  assert.ok(Math.abs(x - 1) < 1e-9, `expected x ~= 1, got ${x}`);
  assert.equal(y, 0);
});

test('a line made entirely of duplicate points does not divide by zero', () => {
  const points = [[5, 5], [5, 5], [5, 5]];
  const [x, y] = interpolateAlongLine(points, 0.5, 0);
  assert.equal(x, 5);
  assert.equal(y, 5);
});

test('matches the manual calculation from the Python interpolate.py session', () => {
  const points = parseLinestring(
    'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)'
  );
  const fraction = (996 - 988) / (998 - 988);

  const [x1, y1] = interpolateAlongLine(points, fraction);
  assert.ok(Math.abs(x1 - -70.778463) < 1e-6);
  assert.ok(Math.abs(y1 - 43.834344) < 1e-6);

  const [x2, y2] = interpolateAlongLine(points, fraction, 5, 'right');
  assert.ok(Math.abs(x2 - -70.778444) < 1e-6);
  assert.ok(Math.abs(y2 - 43.834346) < 1e-6);
});
