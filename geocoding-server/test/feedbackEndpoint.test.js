const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// withTestServer clears SES env vars (see helpers.js), so every one of
// these exercises sendFeedbackNotification's stub path -- confirmed
// separately in emailDelivery.test.js.

test('POST /feedback records a comment with name/email', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const response = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Vasily',
          email: 'vasily@example.com',
          message: 'Any plans for Vermont?',
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { received: true });

      const { rows } = await usersDb.query('SELECT * FROM feedback');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Vasily');
      assert.equal(rows[0].email, 'vasily@example.com');
      assert.equal(rows[0].message, 'Any plans for Vermont?');
    },
    { seedStreets: false }
  ));

test('POST /feedback allows an anonymous comment with no name or email', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const response = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'just a note, no contact info' }),
      });

      assert.equal(response.status, 200);

      const { rows } = await usersDb.query('SELECT * FROM feedback');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, null);
      assert.equal(rows[0].email, null);
    },
    { seedStreets: false }
  ));

test('POST /feedback rejects a missing or blank message', () =>
  withTestServer(
    async ({ port }) => {
      const missing = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Vasily' }),
      });
      assert.equal(missing.status, 400);
      assert.match((await missing.json()).error, /message/);

      const blank = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '   ' }),
      });
      assert.equal(blank.status, 400);
    },
    { seedStreets: false }
  ));

test('POST /feedback rejects a malformed email when one is provided', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', message: 'hello' }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /email/);
    },
    { seedStreets: false }
  ));

test('POST /feedback rejects a message over the length cap', () =>
  withTestServer(
    async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(5001) }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /at most/);
    },
    { seedStreets: false }
  ));
