const test = require('node:test');
const assert = require('node:assert/strict');

test('isPushConfigured is false when env vars are unset', () => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  delete require.cache[require.resolve('../src/pushKeys')];
  const { isPushConfigured } = require('../src/pushKeys');
  assert.equal(isPushConfigured(), false);
});

test('isPushConfigured is true and getVapidPublicKey returns it once all three env vars are set', () => {
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  delete require.cache[require.resolve('../src/pushKeys')];
  const { isPushConfigured, getVapidPublicKey } = require('../src/pushKeys');
  assert.equal(isPushConfigured(), true);
  assert.equal(getVapidPublicKey(), 'test-public-key');
});
