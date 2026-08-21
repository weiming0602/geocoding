const test = require('node:test');
const assert = require('node:assert/strict');

const { ValidationError, UpstreamError } = require('../src/errors');

// getRoadReroute reads process.env.ORS_API_KEY live (not captured once at
// module load, see roadReroute.js) and calls the global fetch -- each
// test below sets/restores both, matching placesSearch.test.js's
// withFetch pattern for the fetch half.
// `apiKey: null` means "delete it" -- distinct from omitting the option
// entirely, since `{ apiKey: undefined }` would otherwise silently fall
// through to the 'test-key' default (a destructuring default applies to
// an explicit `undefined` value, not just a missing key) and defeat the
// "not configured" test below.
function withOrs({ apiKey = 'test-key', fakeFetch } = {}, fn) {
  return async () => {
    const savedKey = process.env.ORS_API_KEY;
    const savedFetch = global.fetch;
    if (apiKey === null) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = apiKey;
    if (fakeFetch) global.fetch = fakeFetch;
    try {
      await fn();
    } finally {
      if (savedKey === undefined) delete process.env.ORS_API_KEY;
      else process.env.ORS_API_KEY = savedKey;
      global.fetch = savedFetch;
    }
  };
}

test('circlePolygon returns a closed ring of the requested point count around the center', () => {
  const { circlePolygon } = require('../src/roadReroute');
  const ring = circlePolygon(43.66, -70.26, 150, 8);
  assert.equal(ring.length, 9); // 8 points + closing point back to the first
  assert.deepEqual(ring[0], ring[8]);
  // Every point should be roughly 150m from the center -- loosely check
  // the ring isn't degenerate (all points identical) or wildly too big.
  const [lon0, lat0] = ring[0];
  assert.notEqual(lon0, -70.26);
  assert.ok(Math.abs(lat0 - 43.66) < 0.01); // well within 150m in degrees
});

test('isOrsConfigured reflects ORS_API_KEY live, not a value captured at require time', () => {
  const { isOrsConfigured } = require('../src/roadReroute');
  const saved = process.env.ORS_API_KEY;
  try {
    delete process.env.ORS_API_KEY;
    assert.equal(isOrsConfigured(), false);
    process.env.ORS_API_KEY = 'some-key';
    assert.equal(isOrsConfigured(), true);
  } finally {
    if (saved === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = saved;
  }
});

test(
  'getRoadReroute throws ValidationError when ORS_API_KEY is not set',
  withOrs(
    {
      apiKey: null,
      // Safety net: if the "not configured" guard didn't fire first, this
      // would throw instead of silently making a real network call.
      fakeFetch: async () => {
        throw new Error('fetch should not be called when ORS_API_KEY is unset');
      },
    },
    async () => {
      const { getRoadReroute } = require('../src/roadReroute');
      await assert.rejects(
        () =>
          getRoadReroute({
            driverLatitude: 43.66,
            driverLongitude: -70.26,
            hazardLatitude: 43.665,
            hazardLongitude: -70.255,
          }),
        ValidationError
      );
    }
  )
);

test(
  'getRoadReroute throws ValidationError when the hazard is farther than the max range',
  withOrs({}, async () => {
    const { getRoadReroute, MAX_HAZARD_DISTANCE_METERS } = require('../src/roadReroute');
    await assert.rejects(
      () =>
        getRoadReroute({
          driverLatitude: 43.66,
          driverLongitude: -70.26,
          hazardLatitude: 45.0, // far north of Portland, well beyond the max
          hazardLongitude: -70.26,
        }),
      ValidationError
    );
    assert.ok(MAX_HAZARD_DISTANCE_METERS > 0);
  })
);

test(
  'getRoadReroute maps an ORS GeoJSON response into { options, rejoinPoint }',
  withOrs(
    {
      fakeFetch: async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.equal(opts.headers.Authorization, 'test-key');
        assert.ok(Array.isArray(body.coordinates) && body.coordinates.length === 2);
        assert.equal(body.options.avoid_polygons.type, 'Polygon');
        return {
          ok: true,
          json: async () => ({
            features: [
              {
                geometry: { type: 'LineString', coordinates: [[-70.26, 43.66], [-70.24, 43.674]] },
                properties: { summary: { distance: 1600, duration: 120 } },
              },
              {
                geometry: { type: 'LineString', coordinates: [[-70.26, 43.66], [-70.242, 43.673]] },
                properties: { summary: { distance: 1750, duration: 140 } },
              },
            ],
          }),
        };
      },
    },
    async () => {
      const { getRoadReroute } = require('../src/roadReroute');
      const result = await getRoadReroute({
        driverLatitude: 43.66,
        driverLongitude: -70.26,
        driverHeading: 45,
        hazardLatitude: 43.665,
        hazardLongitude: -70.255,
      });
      assert.equal(result.options.length, 2);
      assert.equal(result.options[0].distanceMeters, 1600);
      assert.equal(result.options[1].durationSeconds, 140);
      assert.equal(typeof result.rejoinPoint.latitude, 'number');
      assert.equal(typeof result.rejoinPoint.longitude, 'number');
    }
  )
);

test(
  'getRoadReroute throws UpstreamError when ORS itself fails',
  withOrs({ fakeFetch: async () => ({ ok: false, status: 503 }) }, async () => {
    const { getRoadReroute } = require('../src/roadReroute');
    await assert.rejects(
      () =>
        getRoadReroute({
          driverLatitude: 43.66,
          driverLongitude: -70.26,
          hazardLatitude: 43.665,
          hazardLongitude: -70.255,
        }),
      UpstreamError
    );
  })
);

test(
  'getRoadReroute throws UpstreamError when the request itself fails/times out',
  withOrs(
    {
      fakeFetch: async () => {
        throw new Error('timeout');
      },
    },
    async () => {
      const { getRoadReroute } = require('../src/roadReroute');
      await assert.rejects(
        () =>
          getRoadReroute({
            driverLatitude: 43.66,
            driverLongitude: -70.26,
            hazardLatitude: 43.665,
            hazardLongitude: -70.255,
          }),
        UpstreamError
      );
    }
  )
);
