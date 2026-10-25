const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// GET /road-alerts/test/enabled tells the frontend whether to show its
// Road Alerts sandbox tab. Public (no credentials) and read at request
// time, like the flags themselves.
async function enabledWith(env) {
  return withTestServer(
    async ({ port }) => {
      const saved = {};
      for (const [key, value] of Object.entries(env)) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/road-alerts/test/enabled`);
        assert.equal(response.status, 200);
        return response.json();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    { seedStreets: false }
  );
}

test('GET /road-alerts/test/enabled reports both test tools off by default (production)', async () => {
  assert.deepEqual(await enabledWith({}), { testRoadSignals: false, testWeightedPoints: false });
});

test('GET /road-alerts/test/enabled reports each flag that is switched on', async () => {
  assert.deepEqual(await enabledWith({ ALLOW_TEST_ROAD_SIGNALS: 'true' }), { testRoadSignals: true, testWeightedPoints: false });
  assert.deepEqual(await enabledWith({ ALLOW_TEST_WEIGHTED_POINTS: 'true' }), { testRoadSignals: false, testWeightedPoints: true });
});
