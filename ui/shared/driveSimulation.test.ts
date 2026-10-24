import { describe, expect, test } from 'vitest';

import { buildDrivePlan, positionAlongRoute } from './driveSimulation';

// ~111.32m per degree of latitude -- same approximation geo.test.ts uses.
const METERS_PER_DEGREE_LAT = 111320;
const ORIGIN_LAT = 43.6591;
const ORIGIN_LON = -70.2568;

// An L-shaped route: 1000m due north, then east.
const NORTH_END_LAT = ORIGIN_LAT + 1000 / METERS_PER_DEGREE_LAT;
const L_ROUTE: [number, number][] = [
  [ORIGIN_LON, ORIGIN_LAT],
  [ORIGIN_LON, NORTH_END_LAT],
  [ORIGIN_LON + 0.01, NORTH_END_LAT],
];

describe('buildDrivePlan', () => {
  test('accumulates segment lengths', () => {
    const plan = buildDrivePlan(L_ROUTE);
    expect(plan.points).toHaveLength(3);
    expect(plan.cumulativeMeters[1]).toBeCloseTo(1000, -1);
    expect(plan.totalMeters).toBeGreaterThan(plan.cumulativeMeters[1]);
  });

  test('drops consecutive duplicate points', () => {
    const plan = buildDrivePlan([L_ROUTE[0], L_ROUTE[0], L_ROUTE[1]]);
    expect(plan.points).toHaveLength(2);
  });

  test('rejects a route with fewer than two distinct points', () => {
    expect(() => buildDrivePlan([L_ROUTE[0], L_ROUTE[0]])).toThrow();
  });
});

describe('positionAlongRoute', () => {
  const plan = buildDrivePlan(L_ROUTE);

  test('starts at the first point, heading along the first segment', () => {
    const fix = positionAlongRoute(plan, 0);
    expect(fix.latitude).toBeCloseTo(ORIGIN_LAT, 6);
    expect(fix.longitude).toBeCloseTo(ORIGIN_LON, 6);
    expect(fix.headingDeg).toBeCloseTo(0, 0); // due north
    expect(fix.done).toBe(false);
  });

  test('interpolates partway along a segment', () => {
    const fix = positionAlongRoute(plan, 500);
    expect(fix.latitude).toBeCloseTo(ORIGIN_LAT + 500 / METERS_PER_DEGREE_LAT, 4);
    expect(fix.longitude).toBeCloseTo(ORIGIN_LON, 6);
  });

  test('turns onto the next segment once past the corner', () => {
    const fix = positionAlongRoute(plan, plan.cumulativeMeters[1] + 10);
    expect(fix.headingDeg).toBeGreaterThan(85);
    expect(fix.headingDeg).toBeLessThan(95); // roughly due east
  });

  test('clamps past the end and reports done', () => {
    const fix = positionAlongRoute(plan, plan.totalMeters + 5000);
    expect(fix.latitude).toBeCloseTo(NORTH_END_LAT, 6);
    expect(fix.longitude).toBeCloseTo(ORIGIN_LON + 0.01, 6);
    expect(fix.distanceMeters).toBe(plan.totalMeters);
    expect(fix.done).toBe(true);
  });

  test('clamps a negative distance to the start', () => {
    expect(positionAlongRoute(plan, -10).distanceMeters).toBe(0);
  });
});
