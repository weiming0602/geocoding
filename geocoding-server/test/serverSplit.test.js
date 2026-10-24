const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// server.js serves every route; production can instead run
// geocodingServer.js and roadAlertsServer.js as two processes behind
// nginx (see ops/nginx-api.conf.example). These guard the split itself:
// together the two halves must serve exactly what server.js does, with
// no route lost or served twice, and each half must really leave the
// other's routes out.

/** "METHOD /path" for every route registered on an Express 5 app. */
function routeList(app) {
  return app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`))
    .sort();
}

const ROAD_ALERTS_PATH = /^\/(road-alerts|road-signals)(\/|$)/;

async function routesOf(serverModule) {
  return withTestServer(async () => routeList(require(serverModule).app), { seedStreets: false, serverModule });
}

test('geocodingServer + roadAlertsServer together serve exactly server.js routes, with no overlap', async () => {
  const all = await routesOf('../src/server');
  const geocoding = await routesOf('../src/geocodingServer');
  const roadAlerts = await routesOf('../src/roadAlertsServer');

  assert.deepEqual([...geocoding, ...roadAlerts].sort(), all);
  assert.deepEqual(
    geocoding.filter((route) => roadAlerts.includes(route)),
    []
  );
  // Sanity floor, so an accidentally empty app can't pass the checks above.
  assert.ok(geocoding.length >= 10, `only ${geocoding.length} geocoding routes`);
  assert.ok(roadAlerts.length >= 25, `only ${roadAlerts.length} Road Alerts routes`);
});

test('the split matches the nginx rule: every Road Alerts route, and only those, is under /road-alerts or /road-signals', async () => {
  const geocoding = await routesOf('../src/geocodingServer');
  const roadAlerts = await routesOf('../src/roadAlertsServer');
  const path = (route) => route.split(' ')[1];

  assert.deepEqual(roadAlerts.filter((route) => !ROAD_ALERTS_PATH.test(path(route))), []);
  assert.deepEqual(geocoding.filter((route) => ROAD_ALERTS_PATH.test(path(route))), []);
});

test('geocodingServer answers geocoding requests and leaves Road Alerts routes unserved', () =>
  withTestServer(
    async ({ port }) => {
      const quota = await fetch(`http://127.0.0.1:${port}/quota`);
      assert.equal(quota.status, 400); // its own validation error, so the route exists

      const register = await fetch(`http://127.0.0.1:${port}/road-alerts/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com' }),
      });
      assert.equal(register.status, 404);
      assert.match(await register.text(), /Cannot POST/); // Express's own "no such route", not a handler's 404
    },
    { seedStreets: false, serverModule: '../src/geocodingServer' }
  ));

test('roadAlertsServer answers Road Alerts requests and leaves geocoding routes unserved', () =>
  withTestServer(
    async ({ port }) => {
      const register = await fetch(`http://127.0.0.1:${port}/road-alerts/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com' }),
      });
      assert.equal(register.status, 200);
      assert.ok((await register.json()).serviceKey);

      const geocode = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: '1 Main St, Portland, ME 04101' }),
      });
      assert.equal(geocode.status, 404);
      assert.match(await geocode.text(), /Cannot POST/);
    },
    { seedStreets: false, serverModule: '../src/roadAlertsServer' }
  ));

test("both halves' geocoding pools reject writes, same as server.js's", async () => {
  for (const serverModule of ['../src/geocodingServer', '../src/roadAlertsServer']) {
    await withTestServer(
      async ({ db }) => {
        await assert.rejects(() => db.query('CREATE TABLE _should_not_be_created (id int)'), /read-only transaction/);
      },
      { seedStreets: false, serverModule }
    );
  }
});
