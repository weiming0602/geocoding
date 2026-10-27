import { describe, expect, it, test } from 'vitest';

import { buildDrivePlan, positionAlongRoute, routeAheadOf, routeOverlap } from './driveSimulation';

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

describe('routeAheadOf', () => {
  // A straight route due east along the equator, 0 -> 1000 m.
  const M = 1 / 111320;
  const route: [number, number][] = [
    [0, 0],
    [300 * M, 0],
    [600 * M, 0],
    [1000 * M, 0],
  ];

  it('drops the part of the route behind the car, starting from the car itself', () => {
    const car = { latitude: 5 * M, longitude: 450 * M }; // on the road, 450 m along
    const ahead = routeAheadOf(car, route)!;
    expect(ahead[0]).toEqual([car.longitude, car.latitude]);
    expect(ahead[1][0]).toBeCloseTo(450 * M, 10);
    expect(ahead.slice(2)).toEqual([route[2], route[3]]);
    // Never goes back west of the car: no U-turn.
    expect(Math.min(...ahead.slice(1).map(([lon]) => lon))).toBeGreaterThanOrEqual(450 * M - 1e-12);
  });

  it('returns null when the car is no longer on the route', () => {
    expect(routeAheadOf({ latitude: 200 * M, longitude: 450 * M }, route)).toBeNull();
  });
});

describe('routeOverlap', () => {
  const M = 1 / 111320;
  it('is 1 for a route along another and lower for one that leaves it', () => {
    const main: [number, number][] = [[0, 0], [1000 * M, 0]];
    const same: [number, number][] = [[100 * M, 0], [500 * M, 0], [900 * M, 0]];
    const leaves: [number, number][] = [[100 * M, 0], [500 * M, 300 * M], [900 * M, 300 * M]];
    expect(routeOverlap(same, main)).toBe(1);
    expect(routeOverlap(leaves, main)).toBeCloseTo(1 / 3);
  });
});
