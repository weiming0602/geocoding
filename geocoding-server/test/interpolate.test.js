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
