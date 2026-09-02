const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

const TEST_EMAIL = 'alice@example.com';

/** Registers a Road Alerts account against the given usersDb and returns its service key. */
async function registerTestAccount(usersDb, email = TEST_EMAIL) {
  const { registerAccount } = require('../src/roadAlertsAccounts');
  const account = await registerAccount(usersDb, email);
  return account.service_key;
}

// Same pattern as testWeightedPointsEndpoint.test.js's withFlagEnabled --
// allowsTestRoadSignals() (server.js) reads process.env at request time.
function withFlagEnabled(callback) {
  return async (ctx) => {
    const saved = process.env.ALLOW_TEST_ROAD_SIGNALS;
    process.env.ALLOW_TEST_ROAD_SIGNALS = 'true';
    try {
      await callback(ctx);
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_ROAD_SIGNALS = saved;
      else delete process.env.ALLOW_TEST_ROAD_SIGNALS;
    }
  };
}

function testSignalsUrl(port, { email = TEST_EMAIL, serviceKey } = {}) {
  const params = new URLSearchParams();
  if (email !== undefined) params.set('email', email);
  if (serviceKey !== undefined) params.set('serviceKey', serviceKey);
  return `http://127.0.0.1:${port}/road-alerts/test/signals?${params.toString()}`;
}

function roadSignalsUrl(port, { email = TEST_EMAIL, serviceKey, latitude, longitude, radiusMeters } = {}) {
  const params = new URLSearchParams();
  if (email !== undefined) params.set('email', email);
  if (serviceKey !== undefined) params.set('serviceKey', serviceKey);
  if (latitude !== undefined) params.set('latitude', String(latitude));
  if (longitude !== undefined) params.set('longitude', String(longitude));
  if (radiusMeters !== undefined) params.set('radiusMeters', String(radiusMeters));
  return `http://127.0.0.1:${port}/road-signals?${params.toString()}`;
}

// Same reasoning/mechanics as roadSignalsEndpoint.test.js's own withFetch --
// intercepts the 3 upstream New England 511 calls, passes 127.0.0.1 (the
// test server itself) through to the real fetch, and clears roadSignals.js
// from require.cache so its module-scope networkCache doesn't leak
// incidents across tests in this process.
function withFetch(networkResponses, fn) {
  return async (ctx) => {
    delete require.cache[require.resolve('../src/roadSignals')];
    const saved = global.fetch;
    global.fetch = (url, ...args) => {
      if (typeof url === 'string' && url.includes('127.0.0.1')) {
        return saved(url, ...args);
      }
      const match = /networks=([A-Za-z]+)/.exec(url);
      const network = match ? match[1] : null;
      const respond = networkResponses[network];
      if (!respond) {
        return Promise.resolve({ ok: false, status: 500, text: async () => '' });
      }
      return respond();
    };
    try {
      await fn(ctx);
    } finally {
      global.fetch = saved;
    }
  };
}

function emptyNetworkXml() {
  return '<status xmlns="http://its.gov/c2c_icd"><incidentData><net></net></incidentData></status>';
}

function xmlOk(xml) {
  return async () => ({ ok: true, text: async () => xml });
}

const ALL_NETWORKS_EMPTY = {
  Maine: xmlOk(emptyNetworkXml()),
  NewHampshire: xmlOk(emptyNetworkXml()),
  Vermont: xmlOk(emptyNetworkXml()),
};

const ALL_NETWORKS_DOWN = {
  Maine: async () => ({ ok: false, status: 500, text: async () => '' }),
  NewHampshire: async () => ({ ok: false, status: 500, text: async () => '' }),
  Vermont: async () => ({ ok: false, status: 500, text: async () => '' }),
};

test('POST/GET/DELETE /road-alerts/test/signals all 404 when the flag is off', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const postResponse = await fetch(`http://127.0.0.1:${port}/road-alerts/test/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, latitude: 43.9, longitude: -69.8 }),
      });
      assert.equal(postResponse.status, 404);

      const getResponse = await fetch(testSignalsUrl(port, { serviceKey }));
      assert.equal(getResponse.status, 404);

      const deleteResponse = await fetch(testSignalsUrl(port, { serviceKey }), { method: 'DELETE' });
      assert.equal(deleteResponse.status, 404);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/test/signals adds a signal, GET returns it, when the flag is on', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const postResponse = await fetch(`http://127.0.0.1:${port}/road-alerts/test/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          latitude: 43.9106,
          longitude: -69.8148,
          roadway: 'Route 1',
          description: 'Test hazard',
          severity: 'serious',
        }),
      });
      assert.equal(postResponse.status, 200);

      const getResponse = await fetch(testSignalsUrl(port, { serviceKey }));
      assert.equal(getResponse.status, 200);
      const body = await getResponse.json();
      assert.equal(body.signals.length, 1);
      assert.equal(body.signals[0].roadway, 'Route 1');
      assert.equal(body.signals[0].severity, 'serious');
    }),
    { seedStreets: false }
  ));

test('DELETE /road-alerts/test/signals clears every signal for the account', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const { addTestRoadSignal } = require('../src/testRoadSignals');
      await addTestRoadSignal(usersDb, TEST_EMAIL, { latitude: 43.9, longitude: -69.8 });
      await addTestRoadSignal(usersDb, TEST_EMAIL, { latitude: 44.0, longitude: -69.7 });

      const deleteResponse = await fetch(testSignalsUrl(port, { serviceKey }), { method: 'DELETE' });
      assert.equal(deleteResponse.status, 200);
      assert.equal((await deleteResponse.json()).deleted, 2);

      const getResponse = await fetch(testSignalsUrl(port, { serviceKey }));
      assert.equal((await getResponse.json()).signals.length, 0);
    }),
    { seedStreets: false }
  ));

test('GET /road-alerts/test/signals rejects a wrong service key even when the flag is on', () =>
  withTestServer(
    withFlagEnabled(async ({ port, usersDb }) => {
      await registerTestAccount(usersDb);

      const response = await fetch(testSignalsUrl(port, { serviceKey: 'mk_wrong' }));
      assert.equal(response.status, 401);
    }),
    { seedStreets: false }
  ));

test(
  'GET /road-signals merges in a test signal alongside real ones when the flag is on',
  withFetch(ALL_NETWORKS_EMPTY, () =>
    withTestServer(
      withFlagEnabled(async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const { addTestRoadSignal } = require('../src/testRoadSignals');
        await addTestRoadSignal(usersDb, TEST_EMAIL, {
          latitude: 43.66,
          longitude: -70.26,
          roadway: 'Test St',
          severity: 'need_to_know',
        });

        const response = await fetch(
          roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 5000 })
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.signals.length, 1);
        assert.equal(body.signals[0].roadway, 'Test St');
        assert.match(body.signals[0].id, /^test-/);
      }),
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals never merges in a test signal when the flag is off, even if one exists',
  withFetch(ALL_NETWORKS_EMPTY, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const { addTestRoadSignal } = require('../src/testRoadSignals');
        await addTestRoadSignal(usersDb, TEST_EMAIL, { latitude: 43.66, longitude: -70.26, roadway: 'Test St' });

        const response = await fetch(
          roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 5000 })
        );
        const body = await response.json();
        assert.equal(body.signals.length, 0);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals still returns a test signal when every real 511 network is down',
  withFetch(ALL_NETWORKS_DOWN, () =>
    withTestServer(
      withFlagEnabled(async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const { addTestRoadSignal } = require('../src/testRoadSignals');
        await addTestRoadSignal(usersDb, TEST_EMAIL, { latitude: 43.66, longitude: -70.26, roadway: 'Test St' });

        const response = await fetch(
          roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 5000 })
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.signals.length, 1);
        assert.equal(body.signals[0].roadway, 'Test St');
        assert.equal(body.partial, true);
      }),
      { seedStreets: false }
    )
  )
);
