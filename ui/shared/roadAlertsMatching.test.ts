import { describe, expect, test } from 'vitest';
import type { Coordinates, RoadSignal } from './api/types';
import {
  crossTrackDistanceMeters,
  alongTrackDistanceMeters,
  findAlertsForWeightedPoints,
  hazardBetweenUserAndPoint,
  type WeightedPoint,
} from './roadAlertsMatching';

// Real Portland, ME coordinates (same neighborhood as
// roadSignalsEndpoint.test.js's NEAR_INCIDENT), used as the origin for
// every scenario below so distances/bearings stay realistic rather than
// abstract unit-square math.
const USER: Coordinates = { latitude: 43.6591, longitude: -70.2568 };

const METERS_PER_DEGREE_LAT = 111320;

// Independent of roadAlertsMatching.ts's own spherical-trig implementation
// on purpose -- a flat local-plane offset (same approximation
// roadSignals.js's boundingBoxDegrees already uses) is precise enough at
// these distances (a few km) and doesn't risk the test validating the
// module against its own math.
function offsetMeters(origin: Coordinates, northMeters: number, eastMeters: number): Coordinates {
  const latitude = origin.latitude + northMeters / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  const longitude = origin.longitude + eastMeters / metersPerDegreeLon;
  return { latitude, longitude };
}

let nextSignalId = 0;
function makeSignal(coords: Coordinates, overrides: Partial<RoadSignal> = {}): RoadSignal {
  nextSignalId += 1;
  return {
    id: `signal-${nextSignalId}`,
    type: 'traffic_hazard',
    source: 'New England 511',
    network: 'Maine',
    status: 'Active',
    roadway: 'Test Road',
    direction: null,
    crossStreet: null,
    mileMarker: null,
    county: null,
    city: null,
    latitude: coords.latitude,
    longitude: coords.longitude,
    affectedLanes: null,
    affectedLanesDetail: null,
    weightRestriction: null,
    description: null,
    verifiedBy: null,
    createdAt: null,
    lastUpdatedAt: null,
    raw511Severity: null,
    raw511EventType: null,
    severity: 'need_to_know',
    speech: { brief: 'Test hazard.', average: 'Test hazard.', deep: 'Test hazard.' },
    ...overrides,
  };
}

function makeWeightedPoint(coords: Coordinates, weight: number, overrides: Partial<WeightedPoint> = {}): WeightedPoint {
  return { ...coords, weight, ...overrides };
}

// A routine street 5km due north of the user -- e.g. the road toward
// somewhere they drive every day.
const ROUTINE_POINT = offsetMeters(USER, 5000, 0);

describe('crossTrackDistanceMeters / alongTrackDistanceMeters', () => {
  test('a target on the straight path has ~zero cross-track and along-track equal to its distance from the user', () => {
    const midpoint = offsetMeters(USER, 2500, 0);
    expect(crossTrackDistanceMeters(USER, ROUTINE_POINT, midpoint)).toBeLessThan(1);
    expect(alongTrackDistanceMeters(USER, ROUTINE_POINT, midpoint)).toBeCloseTo(2500, -1);
  });

  test('a target 1km off to the side has cross-track close to 1000m', () => {
    const offToTheSide = offsetMeters(USER, 2500, 1000);
    expect(crossTrackDistanceMeters(USER, ROUTINE_POINT, offToTheSide)).toBeCloseTo(1000, -1);
  });
});

describe('hazardBetweenUserAndPoint', () => {
  test('a hazard midway between the user and the weighted point is between them', () => {
    const hazard = offsetMeters(USER, 2500, 0);
    expect(hazardBetweenUserAndPoint(USER, ROUTINE_POINT, hazard)).toBe(true);
  });

  test('a hazard 1000m off the corridor is rejected at the default (300m) corridor width', () => {
    const hazard = offsetMeters(USER, 2500, 1000);
    expect(hazardBetweenUserAndPoint(USER, ROUTINE_POINT, hazard)).toBe(false);
  });

  test('the same off-corridor hazard is accepted once the corridor is widened past it', () => {
    const hazard = offsetMeters(USER, 2500, 1000);
    expect(hazardBetweenUserAndPoint(USER, ROUTINE_POINT, hazard, 1500)).toBe(true);
  });

  test('a hazard beyond the weighted point (past where the user is actually headed) is not between them', () => {
    const hazard = offsetMeters(USER, 6000, 0);
    expect(hazardBetweenUserAndPoint(USER, ROUTINE_POINT, hazard)).toBe(false);
  });

  test('a hazard behind the user is not between them', () => {
    const hazard = offsetMeters(USER, -1000, 0);
    expect(hazardBetweenUserAndPoint(USER, ROUTINE_POINT, hazard)).toBe(false);
  });

  test('user and point coinciding has no path, so nothing is ever between them', () => {
    const hazard = offsetMeters(USER, 100, 0);
    expect(hazardBetweenUserAndPoint(USER, USER, hazard)).toBe(false);
  });
});

describe('findAlertsForWeightedPoints', () => {
  test('a hazard between the user and a routine street triggers an alert', () => {
    const point = makeWeightedPoint(ROUTINE_POINT, 0.8);
    const hazard = makeSignal(offsetMeters(USER, 2500, 0));

    const alerts = findAlertsForWeightedPoints(USER, [point], [hazard]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].signal.id).toBe(hazard.id);
    expect(alerts[0].matchedPoint).toBe(point);
  });

  test('a hazard on a road the user does not routinely drive does not trigger', () => {
    const point = makeWeightedPoint(ROUTINE_POINT, 0.8);
    // 1km off to the side of the routine street -- a different, unrelated road.
    const hazard = makeSignal(offsetMeters(USER, 2500, 1000));

    expect(findAlertsForWeightedPoints(USER, [point], [hazard])).toHaveLength(0);
  });

  test('a weighted point below minWeight is not routine enough to alert on', () => {
    const rarelyDriven = makeWeightedPoint(ROUTINE_POINT, 0.1);
    const hazard = makeSignal(offsetMeters(USER, 2500, 0));

    const alerts = findAlertsForWeightedPoints(USER, [rarelyDriven], [hazard], { minWeight: 0.5 });

    expect(alerts).toHaveLength(0);
  });

  test('a weighted point farther than maxPointDistanceMeters is not reachable soon, so it is ignored', () => {
    const farPoint = makeWeightedPoint(offsetMeters(USER, 20000, 0), 0.9);
    const hazard = makeSignal(offsetMeters(USER, 10000, 0));

    const alerts = findAlertsForWeightedPoints(USER, [farPoint], [hazard], { maxPointDistanceMeters: 10000 });

    expect(alerts).toHaveLength(0);
  });

  test('a hazard relevant to two different routine streets is only reported once', () => {
    const pointA = makeWeightedPoint(ROUTINE_POINT, 0.8);
    const pointB = makeWeightedPoint(offsetMeters(USER, 5000, 50), 0.6);
    const hazard = makeSignal(offsetMeters(USER, 2500, 10));

    const alerts = findAlertsForWeightedPoints(USER, [pointA, pointB], [hazard]);

    expect(alerts).toHaveLength(1);
  });

  test('mimics a full drive: routine street ahead, an unrelated hazard elsewhere is filtered out, a relevant one fires', () => {
    const commute = makeWeightedPoint(ROUTINE_POINT, 0.9);
    const onceVisited = makeWeightedPoint(offsetMeters(USER, 3000, 4000), 0.05);

    const relevantHazard = makeSignal(offsetMeters(USER, 3000, 0), { severity: 'serious' });
    const unrelatedHazard = makeSignal(offsetMeters(USER, 3000, 4100));
    const behindHazard = makeSignal(offsetMeters(USER, -500, 0));

    const alerts = findAlertsForWeightedPoints(USER, [commute, onceVisited], [
      relevantHazard,
      unrelatedHazard,
      behindHazard,
    ]);

    expect(alerts.map((a) => a.signal.id)).toEqual([relevantHazard.id]);
    expect(alerts[0].signal.severity).toBe('serious');
  });
});
