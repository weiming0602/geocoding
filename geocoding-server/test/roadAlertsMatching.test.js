const test = require('node:test');
const assert = require('node:assert/strict');

const { findAlertsForWeightedPoints, shouldStronglyAlert } = require('../src/roadAlertsMatching');

// Real Portland, ME coordinates, mirroring ui/shared/roadAlertsMatching.test.ts's own USER constant.
const USER = { latitude: 43.6591, longitude: -70.2568 };
const METERS_PER_DEGREE_LAT = 111320;

function offsetMeters(origin, northMeters, eastMeters) {
  const latitude = origin.latitude + northMeters / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  const longitude = origin.longitude + eastMeters / metersPerDegreeLon;
  return { latitude, longitude };
}

function makeSignal(coords, overrides = {}) {
  return {
    id: overrides.id || 'signal-1',
    latitude: coords.latitude,
    longitude: coords.longitude,
    severity: overrides.severity || 'serious',
    ...overrides,
  };
}

test('findAlertsForWeightedPoints matches a hazard sitting between the user and a routine point', () => {
  const point = { ...offsetMeters(USER, 2000, 0), weight: 5 };
  const hazard = offsetMeters(USER, 1000, 0); // halfway along the path, on it
  const signal = makeSignal(hazard);

  const alerts = findAlertsForWeightedPoints(USER, [point], [signal]);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].signal.id, 'signal-1');
});

test('findAlertsForWeightedPoints does not match a hazard far off the corridor', () => {
  const point = { ...offsetMeters(USER, 2000, 0), weight: 5 };
  const hazard = offsetMeters(USER, 1000, 5000); // 5km east of the path
  const signal = makeSignal(hazard);

  const alerts = findAlertsForWeightedPoints(USER, [point], [signal]);

  assert.equal(alerts.length, 0);
});

test('shouldStronglyAlert is true only for serious and need_to_know', () => {
  assert.equal(shouldStronglyAlert('serious'), true);
  assert.equal(shouldStronglyAlert('need_to_know'), true);
  assert.equal(shouldStronglyAlert('proximity'), false);
  assert.equal(shouldStronglyAlert('fun_to_know'), false);
});
