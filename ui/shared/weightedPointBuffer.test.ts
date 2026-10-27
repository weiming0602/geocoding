import { describe, expect, test } from 'vitest';
import type { Coordinates } from './api/types';
import { WeightedPointPingBuffer, WEIGHTED_POINT_EXCLUSION_RADIUS_METERS } from './weightedPointBuffer';

// Same Portland, ME origin and flat-plane offset helper as
// roadAlertsMatching.test.ts, for the same reason: realistic distances,
// independent of this module's own haversine math.
const START: Coordinates = { latitude: 43.6591, longitude: -70.2568 };

const METERS_PER_DEGREE_LAT = 111320;

function offsetMeters(origin: Coordinates, northMeters: number, eastMeters: number): Coordinates {
  const latitude = origin.latitude + northMeters / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  const longitude = origin.longitude + eastMeters / metersPerDegreeLon;
  return { latitude, longitude };
}

const FAR = WEIGHTED_POINT_EXCLUSION_RADIUS_METERS + 200;
const NEAR = WEIGHTED_POINT_EXCLUSION_RADIUS_METERS - 200;

describe('WeightedPointPingBuffer', () => {
  test('the first ping is treated as the session start and never sent', () => {
    const buffer = new WeightedPointPingBuffer();
    expect(buffer.addPing(START)).toEqual([]);
  });

  test('a ping within the exclusion radius of the start is never queued or sent', () => {
    const buffer = new WeightedPointPingBuffer();
    buffer.addPing(START);
    const nearStart = offsetMeters(START, NEAR, 0);
    expect(buffer.addPing(nearStart)).toEqual([]);
    // Even once the drive clearly moves on, the near-start ping was never
    // queued in the first place, so there's nothing to flush for it.
    const farAway = offsetMeters(START, FAR * 3, 0);
    expect(buffer.addPing(farAway)).toEqual([]);
  });

  test('a ping beyond the start radius is queued, then flushed once a later ping moves on from it', () => {
    const buffer = new WeightedPointPingBuffer();
    buffer.addPing(START);
    const firstRoutinePing = offsetMeters(START, FAR, 0);
    expect(buffer.addPing(firstRoutinePing)).toEqual([]);

    const stillNearby = offsetMeters(firstRoutinePing, NEAR, 0);
    expect(buffer.addPing(stillNearby)).toEqual([]);

    const movedOn = offsetMeters(firstRoutinePing, FAR, 0);
    expect(buffer.addPing(movedOn)).toEqual([firstRoutinePing]);
  });

  test('flushAtStop with a known stop position sends pings confirmed far enough from it, drops the rest', () => {
    const buffer = new WeightedPointPingBuffer();
    buffer.addPing(START);
    const midTripPing = offsetMeters(START, FAR, 0);
    buffer.addPing(midTripPing);
    const stopPosition = offsetMeters(midTripPing, FAR, 0);

    expect(buffer.flushAtStop(stopPosition)).toEqual([midTripPing]);
  });

  test('flushAtStop drops a pending ping that is still within the exclusion radius of the stop', () => {
    const buffer = new WeightedPointPingBuffer();
    buffer.addPing(START);
    const nearHomeApproach = offsetMeters(START, FAR, 0);
    buffer.addPing(nearHomeApproach);
    const stopPosition = offsetMeters(nearHomeApproach, NEAR, 50);

    expect(buffer.flushAtStop(stopPosition)).toEqual([]);
  });

  test('flushAtStop with no stop position drops everything still pending', () => {
    const buffer = new WeightedPointPingBuffer();
    buffer.addPing(START);
    buffer.addPing(offsetMeters(START, FAR, 0));

    expect(buffer.flushAtStop()).toEqual([]);
  });

  test('flushAtStop resets the buffer so a new session starts clean', () => {
    const buffer = new WeightedPointPingBuffer();
    buffer.addPing(START);
    buffer.addPing(offsetMeters(START, FAR, 0));
    buffer.flushAtStop();

    // A fresh session: this position is now treated as a new start, not
    // measured against the previous session's start.
    const newSessionStart = offsetMeters(START, FAR * 10, 0);
    expect(buffer.addPing(newSessionStart)).toEqual([]);
  });

  test('a custom exclusion radius is honored', () => {
    const buffer = new WeightedPointPingBuffer(1000);
    buffer.addPing(START);
    // 600m would clear the default 400m radius but not this buffer's 1000m one.
    const within1000 = offsetMeters(START, 600, 0);
    expect(buffer.addPing(within1000)).toEqual([]);
  });
});
