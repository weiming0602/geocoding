const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');
const { upsertUser, getUser } = require('../src/users');

// Regression for quota overspend: quota used to be checked when a request
// arrived but only recorded once the geocoding finished, so every request
// overlapping a slow batch saw the same remaining quota -- 8 concurrent
// 10-address batches all succeeded on a 10-address plan (used 80/10).

function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('concurrent POST /geocode/batch requests can never spend more than the plan', () =>
  withTestServer(async ({ port, usersDb }) => {
    const { service_key: serviceKey } = await upsertUser(usersDb, 'race@example.com', 10);
    const fileContent = Array.from({ length: 10 }, () => '1 Nowhere St, 04011').join('\n');

    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        post(port, '/geocode/batch', { email: 'race@example.com', serviceKey, fileContent }).then((r) => r.status)
      )
    );

    assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 429).length, 7, `statuses: ${statuses}`);
    assert.equal((await getUser(usersDb, 'race@example.com')).used_this_period, 10);
  }));

test('concurrent POST /geocode requests can never spend more than the plan', () =>
  withTestServer(async ({ port, usersDb }) => {
    const { service_key: serviceKey } = await upsertUser(usersDb, 'race@example.com', 3);

    const statuses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(port, '/geocode', {
          email: 'race@example.com',
          serviceKey,
          address: '997 Pequawket Trl, 04091',
        }).then((r) => r.status)
      )
    );

    assert.equal(statuses.filter((s) => s === 200).length, 3, `statuses: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 429).length, 7, `statuses: ${statuses}`);
    assert.equal((await getUser(usersDb, 'race@example.com')).used_this_period, 3);
  }));

test('POST /geocode gives the reserved quota back when the address is not found', () =>
  withTestServer(async ({ port, usersDb }) => {
    const { service_key: serviceKey } = await upsertUser(usersDb, 'alice@example.com', 5);

    const notFound = await post(port, '/geocode', {
      email: 'alice@example.com',
      serviceKey,
      address: '1 Nowhere St, 04011',
    });
    assert.equal(notFound.status, 404);
    const outOfRange = await post(port, '/geocode', {
      email: 'alice@example.com',
      serviceKey,
      address: '99999 Pequawket Trl, 04091',
    });
    assert.equal(outOfRange.status, 422);

    assert.equal((await getUser(usersDb, 'alice@example.com')).used_this_period, 0);
  }));

test('POST /reverse-geocode gives the reserved quota back on a bad request', () =>
  withTestServer(async ({ port, usersDb }) => {
    const { service_key: serviceKey } = await upsertUser(usersDb, 'alice@example.com', 5);
    const response = await post(port, '/reverse-geocode', {
      email: 'alice@example.com',
      serviceKey,
      latitude: 'not a number',
      longitude: -70,
    });
    assert.equal(response.status, 400);
    assert.equal((await getUser(usersDb, 'alice@example.com')).used_this_period, 0);
  }));
