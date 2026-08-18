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

function roadSignalsUrl(port, { email = TEST_EMAIL, serviceKey, latitude, longitude, radiusMeters } = {}) {
  const params = new URLSearchParams();
  if (email !== undefined) params.set('email', email);
  if (serviceKey !== undefined) params.set('serviceKey', serviceKey);
  if (latitude !== undefined) params.set('latitude', String(latitude));
  if (longitude !== undefined) params.set('longitude', String(longitude));
  if (radiusMeters !== undefined) params.set('radiusMeters', String(radiusMeters));
  return `http://127.0.0.1:${port}/road-signals?${params.toString()}`;
}

function incidentXml({ roadway, lat, lon, eventType, severity }) {
  return `
    <incident>
      <startLocation>
        <roadway>${roadway}</roadway>
        <direction>Northbound</direction>
        <lat>${lat}</lat>
        <lon>${lon}</lon>
      </startLocation>
      <desc>Test incident</desc>
      <status>Active</status>
      <severity>${severity}</severity>
      <eventType>${eventType}</eventType>
    </incident>
  `;
}

function statusXml(incidents) {
  return `<status xmlns="http://its.gov/c2c_icd"><incidentData><net>${incidents.join('')}</net></incidentData></status>`;
}

// A near-Portland-ME incident (within the default test radius) and a
// far-away one, used to exercise the bbox filter through the real HTTP
// route. lat/lon are integer microdegrees (real 511 XML, confirmed by
// live sampling), not decimal degrees -- 43661000 means 43.661.
const NEAR_INCIDENT = incidentXml({
  roadway: 'Main St',
  lat: 43661000,
  lon: -70261000,
  eventType: 'Accident',
  severity: 'Moderate',
});
const FAR_INCIDENT = incidentXml({
  roadway: 'Route 4',
  lat: 45000000,
  lon: -73000000,
  eventType: 'Accident',
  severity: 'Moderate',
});

// GET /road-signals fans out to 3 upstream New England 511 URLs (one per
// state network) -- the fake below inspects the `networks` query param to
// decide which canned XML to return per state, and passes the local
// 127.0.0.1 test-server calls through to the real fetch, same pattern as
// placesSearchEndpoint.test.js's withFetch.
//
// roadSignals.js keeps an in-memory per-network cache (networkCache) at
// module scope. withTestServer only clears src/server.js from
// require.cache, not its dependencies, so that cache would otherwise leak
// real incidents across tests in this same file/process -- clearing
// roadSignals.js's own cache entry here forces a fresh module (and a
// fresh, empty cache) each time server.js is re-required.
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

function xmlOk(xml) {
  return async () => ({ ok: true, text: async () => xml });
}

test(
  'GET /road-signals returns normalized, bbox-filtered signals for a registered account',
  withFetch(
    {
      Maine: xmlOk(statusXml([NEAR_INCIDENT, FAR_INCIDENT])),
      NewHampshire: xmlOk(statusXml([])),
      Vermont: xmlOk(statusXml([])),
    },
    () =>
      withTestServer(
        async ({ port, usersDb }) => {
          const serviceKey = await registerTestAccount(usersDb);
          const response = await fetch(
            roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 5000 })
          );
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.signals.length, 1);
          assert.equal(body.signals[0].roadway, 'Main St');
          assert.equal(body.signals[0].type, 'traffic_hazard');
          assert.equal(body.partial, false);
          assert.deepEqual(body.failedNetworks, []);
        },
        { seedStreets: false }
      )
  )
);

test(
  'GET /road-signals rejects a radius over the max with 400',
  withFetch({}, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const response = await fetch(
          roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 999999 })
        );
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /radiusMeters/);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals rejects a missing latitude with 400',
  withFetch({}, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const response = await fetch(roadSignalsUrl(port, { serviceKey, longitude: -70.26 }));
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /latitude/);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals rejects a missing email or serviceKey with 400',
  withFetch({}, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);

        const noEmail = await fetch(
          `http://127.0.0.1:${port}/road-signals?serviceKey=${serviceKey}&latitude=43.66&longitude=-70.26`
        );
        assert.equal(noEmail.status, 400);
        assert.match((await noEmail.json()).error, /email/);

        const noKey = await fetch(
          roadSignalsUrl(port, { serviceKey: undefined, latitude: 43.66, longitude: -70.26 })
        );
        assert.equal(noKey.status, 400);
        assert.match((await noKey.json()).error, /serviceKey/);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals returns 404 for an unregistered email',
  withFetch({}, () =>
    withTestServer(
      async ({ port }) => {
        const response = await fetch(
          roadSignalsUrl(port, {
            email: 'nobody@example.com',
            serviceKey: 'mk_whatever',
            latitude: 43.66,
            longitude: -70.26,
          })
        );
        assert.equal(response.status, 404);
        assert.match((await response.json()).error, /no Road Alerts account/);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals returns 401 for a registered email with the wrong service key',
  withFetch({}, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        await registerTestAccount(usersDb);
        const response = await fetch(
          roadSignalsUrl(port, { serviceKey: 'mk_wrong', latitude: 43.66, longitude: -70.26 })
        );
        assert.equal(response.status, 401);
        assert.match((await response.json()).error, /service key/);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals returns 502 when every network fails',
  withFetch(
    {
      Maine: async () => ({ ok: false, status: 500, text: async () => '' }),
      NewHampshire: async () => ({ ok: false, status: 500, text: async () => '' }),
      Vermont: async () => ({ ok: false, status: 500, text: async () => '' }),
    },
    () =>
      withTestServer(
        async ({ port, usersDb }) => {
          const serviceKey = await registerTestAccount(usersDb);
          const response = await fetch(
            roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 5000 })
          );
          assert.equal(response.status, 502);
        },
        { seedStreets: false }
      )
  )
);

test(
  'GET /road-signals degrades gracefully when only one network fails',
  withFetch(
    {
      Maine: xmlOk(statusXml([NEAR_INCIDENT])),
      NewHampshire: async () => ({ ok: false, status: 500, text: async () => '' }),
      Vermont: xmlOk(statusXml([])),
    },
    () =>
      withTestServer(
        async ({ port, usersDb }) => {
          const serviceKey = await registerTestAccount(usersDb);
          const response = await fetch(
            roadSignalsUrl(port, { serviceKey, latitude: 43.66, longitude: -70.26, radiusMeters: 5000 })
          );
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.partial, true);
          assert.deepEqual(body.failedNetworks, ['NewHampshire']);
          assert.equal(body.signals.length, 1);
        },
        { seedStreets: false }
      )
  )
);
