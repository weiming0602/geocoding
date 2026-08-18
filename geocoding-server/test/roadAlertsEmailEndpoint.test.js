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

const SAMPLE_SIGNAL = {
  id: 'ME26-002841',
  roadway: 'I-95',
  severity: 'proximity',
  latitude: 43.168363,
  longitude: -70.653171,
  source: 'New England 511',
  network: 'Maine',
  speech: { brief: 'Traffic on I-95.', average: 'Slow traffic on I-95 south.', deep: 'Slow traffic on I-95 southbound near York.' },
};

test('POST /road-alerts/email-alert emails the signal to the account\'s own address (stubbed without SES configured)', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/email-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, signal: SAMPLE_SIGNAL }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.emailed, false);
      assert.equal(body.stubbed, true);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/email-alert logs the alert for the digest when the account is opted in', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);
      const { updateDigestOptIn } = require('../src/roadAlertsAccounts');
      await updateDigestOptIn(usersDb, TEST_EMAIL, true);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/email-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, signal: SAMPLE_SIGNAL }),
      });

      // The immediate send is unaffected either way.
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.stubbed, true);

      const { getPendingAlertsGroupedByEmail } = require('../src/roadAlertsSurfacedLog');
      const grouped = await getPendingAlertsGroupedByEmail(usersDb);
      const pending = grouped.get(TEST_EMAIL) ?? [];
      assert.equal(pending.length, 1);
      assert.equal(pending[0].signal_id, SAMPLE_SIGNAL.id);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/email-alert does not log the alert when the account is not opted in', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/email-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, signal: SAMPLE_SIGNAL }),
      });
      assert.equal(response.status, 200);

      const { getPendingAlertsGroupedByEmail } = require('../src/roadAlertsSurfacedLog');
      const grouped = await getPendingAlertsGroupedByEmail(usersDb);
      assert.equal(grouped.has(TEST_EMAIL), false);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/email-alert rejects a wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerTestAccount(usersDb);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/email-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey: 'mk_wrong', signal: SAMPLE_SIGNAL }),
      });

      assert.equal(response.status, 401);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/email-alert rejects a missing/malformed signal', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const noSignal = await fetch(`http://127.0.0.1:${port}/road-alerts/email-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey }),
      });
      assert.equal(noSignal.status, 400);

      const noSpeech = await fetch(`http://127.0.0.1:${port}/road-alerts/email-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, serviceKey, signal: { id: 'x' } }),
      });
      assert.equal(noSpeech.status, 400);
    },
    { seedStreets: false }
  ));

test('POST /road-alerts/email-alert never sends to an email other than the authenticated account\'s own', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb, 'alice@example.com');
      await registerTestAccount(usersDb, 'bob@example.com');

      // alice's own key can't be used to email bob's address -- the route
      // only ever takes one `email`, used for both auth and the send
      // target, so there's no field that could point delivery elsewhere.
      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/email-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bob@example.com', serviceKey, signal: SAMPLE_SIGNAL }),
      });

      assert.equal(response.status, 401);
    },
    { seedStreets: false }
  ));
