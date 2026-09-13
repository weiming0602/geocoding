import { describe, expect, test } from 'vitest';
import type { Coordinates, RoadSignal } from './api/types';
import {
  approachedWeightedPoints,
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

describe('approachedWeightedPoints', () => {
  // A trail moving from USER 100m north -- above the 50m default
  // displacement threshold, so its trend (due north) is trusted.
  const TRAIL_TOWARD_NORTH = [
    { ...USER, timestampMs: 0 },
    { ...offsetMeters(USER, 100, 0), timestampMs: 15000 },
  ];

  test('keeps a weighted point the trail is trending toward', () => {
    const point = makeWeightedPoint(ROUTINE_POINT, 0.8); // 5km due north of USER

    const result = approachedWeightedPoints(TRAIL_TOWARD_NORTH, [point]);

    expect(result).toEqual([point]);
  });

  test('excludes a weighted point the trail is trending away from', () => {
    const trailTowardSouth = [
      { ...USER, timestampMs: 0 },
      { ...offsetMeters(USER, -100, 0), timestampMs: 15000 },
    ];
    const point = makeWeightedPoint(ROUTINE_POINT, 0.8); // due north -- opposite direction

    expect(approachedWeightedPoints(trailTowardSouth, [point])).toHaveLength(0);
  });

  test('passes every point through unfiltered when the trail has fewer than 2 samples', () => {
    const point = makeWeightedPoint(offsetMeters(USER, 0, 5000), 0.8); // due east -- would fail a north trend

    const result = approachedWeightedPoints([{ ...USER, timestampMs: 0 }], [point]);

    expect(result).toEqual([point]);
  });

  test('passes every point through unfiltered when trail displacement is below the reliability threshold', () => {
    // Only 10m apart -- below the 50m default, even though the direction
    // implied (north) doesn't match this point's actual direction (east).
    const barelyMovedTrail = [
      { ...USER, timestampMs: 0 },
      { ...offsetMeters(USER, 10, 0), timestampMs: 15000 },
    ];
    const point = makeWeightedPoint(offsetMeters(USER, 0, 5000), 0.8); // due east

    const result = approachedWeightedPoints(barelyMovedTrail, [point]);

    expect(result).toEqual([point]);
  });

  test('keeps only the points consistent with the trend, given points in different directions', () => {
    const northPoint = makeWeightedPoint(ROUTINE_POINT, 0.8); // due north
    const eastPoint = makeWeightedPoint(offsetMeters(USER, 0, 5000), 0.6); // due east

    const result = approachedWeightedPoints(TRAIL_TOWARD_NORTH, [northPoint, eastPoint]);

    expect(result).toEqual([northPoint]);
  });

  test('a custom approachConeDeg widens or narrows what counts as consistent', () => {
    // ~30 degrees east of the trail's north trend -- inside a wide cone,
    // outside the default 45-degree one.
    const diagonalPoint = makeWeightedPoint(offsetMeters(USER, 5000, 2887), 0.8);

    expect(approachedWeightedPoints(TRAIL_TOWARD_NORTH, [diagonalPoint])).toHaveLength(0);
    expect(
      approachedWeightedPoints(TRAIL_TOWARD_NORTH, [diagonalPoint], { approachConeDeg: 90 })
    ).toEqual([diagonalPoint]);
  });

  test('a 4-sample trail with a turn reflects the overall oldest-to-newest trend, not an average of each leg', () => {
    // Both apps feed this a sliding window of up to 4 samples, not just 2
    // -- this trail turns partway through: due north for the first two
    // samples (trail[0] -> trail[1]), then due east for the last two
    // (trail[1] -> trail[2], trail[2] -> trail[3]). The implementation
    // only ever reads trail[0] and trail[trail.length - 1], so the trend
    // here is the straight-line bearing from USER to a point 200m north +
    // 200m east of it -- exactly 45 degrees (northeast) -- not an average
    // of the individual legs' bearings (0, 90, 90 degrees) and not just
    // the most recent leg's bearing (90 degrees, due east).
    const turningTrail = [
      { ...USER, timestampMs: 0 },
      { ...offsetMeters(USER, 200, 0), timestampMs: 15000 },
      { ...offsetMeters(USER, 200, 100), timestampMs: 30000 },
      { ...offsetMeters(USER, 200, 200), timestampMs: 45000 },
    ];
    const newest = offsetMeters(USER, 200, 200);

    // 5km out along the actual 45-degree trend (3536m north + 3536m east,
    // since 5000 * cos(45deg) = 5000 * sin(45deg) = 3535.5) -- 0 degrees
    // off the trend, well inside the default 45-degree cone (22.5 degrees
    // either side).
    const onTrend = makeWeightedPoint(offsetMeters(newest, 3536, 3536), 0.8);
    // Due east of the newest fix (90 degrees) -- the most recent leg's
    // own direction, and exactly what the driver was just heading, but 45
    // degrees off the overall 45-degree trend, outside the cone's
    // 22.5-degree half-width. Excluding this proves the function used the
    // overall trend, not the last leg alone.
    const lastLegDirection = makeWeightedPoint(offsetMeters(newest, 0, 5000), 0.6);

    const result = approachedWeightedPoints(turningTrail, [onTrend, lastLegDirection]);

    expect(result).toEqual([onTrend]);
  });
});
