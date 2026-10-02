const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

test('GET /road-signals/push-public-key returns 404 when unconfigured', () =>
  withTestServer(
    async ({ port }) => {
      delete process.env.VAPID_PUBLIC_KEY;
      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-public-key`);
      assert.equal(response.status, 404);
    },
    { seedStreets: false }
  ));

test('GET /road-signals/push-public-key returns the key when configured', () =>
  withTestServer(
    async ({ port }) => {
      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = 'test-private-key';
      process.env.VAPID_SUBJECT = 'mailto:test@example.com';
      const response = await fetch(`http://127.0.0.1:${port}/road-signals/push-public-key`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.publicKey, 'test-public-key');
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      delete process.env.VAPID_SUBJECT;
    },
    { seedStreets: false }
  ));
