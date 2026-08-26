const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// /places/search calls the global fetch to reach Overpass -- but the
// test itself also uses global fetch to call the local test server, so
// the fake below must only intercept the Overpass call and pass
// everything else (the 127.0.0.1 test-server calls) through to the
// real fetch, or the test would "mock" its own HTTP client too.
function withFetch(fakeOverpassResponse, fn) {
  return async (ctx) => {
    const saved = global.fetch;
    global.fetch = (url, ...args) => {
      if (typeof url === 'string' && url.includes('127.0.0.1')) {
        return saved(url, ...args);
      }
      return fakeOverpassResponse();
    };
    try {
      await fn(ctx);
    } finally {
      global.fetch = saved;
    }
  };
}

test(
  'POST /places/search returns extracted addresses',
  withFetch(
    async () => ({
      ok: true,
      json: async () => ({
        elements: [
          {
            lat: 43.6591,
            lon: -70.2568,
            tags: {
              name: 'Thai Palace',
              'addr:housenumber': '10',
              'addr:street': 'Main St',
              'addr:city': 'Portland',
              'addr:state': 'ME',
              'addr:postcode': '04101',
            },
          },
        ],
      }),
    }),
    () =>
      withTestServer(
        async ({ port }) => {
          const response = await fetch(`http://127.0.0.1:${port}/places/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: 'thai',
              latitude: 43.66,
              longitude: -70.26,
              radiusMeters: 5000,
            }),
          });

          assert.equal(response.status, 200);
          const body = await response.json();
          assert.deepEqual(body.results, [
            { name: 'Thai Palace', address: '10 Main St, Portland, ME 04101', latitude: 43.6591, longitude: -70.2568 },
          ]);
          assert.equal(body.skipped, 0);
          assert.equal(body.truncated, false);
        },
        { seedStreets: false }
      )
  )
);

test('POST /places/search rejects a missing query with 400', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/places/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: 43.66, longitude: -70.26, radiusMeters: 5000 }),
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /query/);
    },
    { seedStreets: false }
  ));

test('POST /places/search rejects a radius over the max with 400', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/places/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'thai',
          latitude: 43.66,
          longitude: -70.26,
          radiusMeters: 999999,
        }),
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /radiusMeters/);
    },
    { seedStreets: false }
  ));
