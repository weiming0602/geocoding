import { describe, expect, test } from 'vitest';

import { estimateSpeedMetersPerSecond } from './geo';

// Portland, ME -- arbitrary real coordinates, consistent with this
// repo's other geo tests (see roadAlertsMatching.test.ts).
const ORIGIN = { latitude: 43.6591, longitude: -70.2568 };
// ~111.32m per degree of latitude -- exact enough at these small offsets
// for a known, checkable expected speed (same approximation this repo's
// other geo tests already rely on).
const METERS_PER_DEGREE_LAT = 111320;

describe('estimateSpeedMetersPerSecond', () => {
  test('computes distance over time between two fixes', () => {
    const previous = { ...ORIGIN, timestampMs: 0 };
    const current = {
      latitude: ORIGIN.latitude + 100 / METERS_PER_DEGREE_LAT, // ~100m north
      longitude: ORIGIN.longitude,
      timestampMs: 10_000, // 10 seconds later
    };
    // ~100m / 10s = ~10 m/s
    expect(estimateSpeedMetersPerSecond(previous, current)).toBeCloseTo(10, 0);
  });

  test('returns null when the fixes are simultaneous', () => {
    const previous = { ...ORIGIN, timestampMs: 5000 };
    const current = { ...ORIGIN, timestampMs: 5000 };
    expect(estimateSpeedMetersPerSecond(previous, current)).toBeNull();
  });

  test('returns null when the fixes are out of order', () => {
    const previous = { ...ORIGIN, timestampMs: 5000 };
    const current = { ...ORIGIN, timestampMs: 1000 };
    expect(estimateSpeedMetersPerSecond(previous, current)).toBeNull();
  });
});
