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

function rerouteUrl(port, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  return `http://127.0.0.1:${port}/road-signals/reroute?${qs.toString()}`;
}

const BASE_PARAMS = {
  email: TEST_EMAIL,
  driverLatitude: 43.66,
  driverLongitude: -70.26,
  hazardLatitude: 43.665,
  hazardLongitude: -70.255,
};

function fakeOrsResponse() {
  return {
    ok: true,
    json: async () => ({
      features: [
        {
          geometry: { type: 'LineString', coordinates: [[-70.26, 43.66], [-70.24, 43.674]] },
          properties: { summary: { distance: 1600, duration: 120 } },
        },
      ],
    }),
  };
}

// GET /road-signals/reroute hits ORS directly (one POST call, not one
// per state network like /road-signals) -- the fake below only
// intercepts that call, passing 127.0.0.1 test-server calls through to
// the real fetch, same pattern as roadSignalsEndpoint.test.js.
function withFetch(orsResponse, fn) {
  return async (ctx) => {
    const saved = global.fetch;
    global.fetch = (url, ...args) => {
      if (typeof url === 'string' && url.includes('127.0.0.1')) return saved(url, ...args);
      return orsResponse();
    };
    const savedKey = process.env.ORS_API_KEY;
    process.env.ORS_API_KEY = 'test-key';
    try {
      await fn(ctx);
    } finally {
      global.fetch = saved;
      if (savedKey === undefined) delete process.env.ORS_API_KEY;
      else process.env.ORS_API_KEY = savedKey;
    }
  };
}

test(
  'GET /road-signals/reroute returns route options for a registered account',
  withFetch(fakeOrsResponse, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const response = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey }));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.options.length, 1);
        assert.equal(body.options[0].distanceMeters, 1600);
        assert.ok(typeof body.rejoinPoint.latitude === 'number');
        assert.ok(typeof body.rejoinPoint.longitude === 'number');
      },
      { seedStreets: false }
    )
  )
);

test('GET /road-signals/reroute returns 400 when ORS_API_KEY is not configured', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const savedKey = process.env.ORS_API_KEY;
      delete process.env.ORS_API_KEY;
      try {
        const response = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey }));
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /not configured/);
      } finally {
        if (savedKey !== undefined) process.env.ORS_API_KEY = savedKey;
      }
    },
    { seedStreets: false }
  )
);

test(
  'GET /road-signals/reroute rejects a missing hazard coordinate with 400',
  withFetch(fakeOrsResponse, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);
        const response = await fetch(
          rerouteUrl(port, {
            email: TEST_EMAIL,
            serviceKey,
            driverLatitude: 43.66,
            driverLongitude: -70.26,
          })
        );
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /hazard/);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals/reroute rejects a missing email or serviceKey with 400',
  withFetch(fakeOrsResponse, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        const serviceKey = await registerTestAccount(usersDb);

        const noEmail = await fetch(rerouteUrl(port, { ...BASE_PARAMS, email: undefined, serviceKey }));
        assert.equal(noEmail.status, 400);
        assert.match((await noEmail.json()).error, /email/);

        const noKey = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey: undefined }));
        assert.equal(noKey.status, 400);
        assert.match((await noKey.json()).error, /serviceKey/);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals/reroute returns 404 for an unregistered email',
  withFetch(fakeOrsResponse, () =>
    withTestServer(
      async ({ port }) => {
        const response = await fetch(
          rerouteUrl(port, { ...BASE_PARAMS, email: 'nobody@example.com', serviceKey: 'mk_whatever' })
        );
        assert.equal(response.status, 404);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals/reroute returns 401 for a registered email with the wrong service key',
  withFetch(fakeOrsResponse, () =>
    withTestServer(
      async ({ port, usersDb }) => {
        await registerTestAccount(usersDb);
        const response = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey: 'mk_wrong' }));
        assert.equal(response.status, 401);
      },
      { seedStreets: false }
    )
  )
);

test(
  'GET /road-signals/reroute returns 502 when ORS itself fails',
  withFetch(
    async () => ({ ok: false, status: 500 }),
    () =>
      withTestServer(
        async ({ port, usersDb }) => {
          const serviceKey = await registerTestAccount(usersDb);
          const response = await fetch(rerouteUrl(port, { ...BASE_PARAMS, serviceKey }));
          assert.equal(response.status, 502);
        },
        { seedStreets: false }
      )
  )
);
