const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

const TEST_EMAIL = 'alice@example.com';
// Same known fixture point as reverseGeocode.test.js's round-trip case
// -- 997 Pequawket Trl, resolves to tlid 78056932.
const LATITUDE = 43.834390719401604;
const LONGITUDE = -70.77854947339969;

/** Registers a Road Alerts account, sets a username, returns its service key. */
async function registerTestAccount(usersDb, email = TEST_EMAIL, username = 'Alice R') {
  const { registerAccount, updateUsername } = require('../src/roadAlertsAccounts');
  const account = await registerAccount(usersDb, email);
  if (username) await updateUsername(usersDb, email, username);
  return account.service_key;
}

test('GET /road-alerts/topic returns null before anything is posted', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const response = await fetch(
        `http://127.0.0.1:${port}/road-alerts/topic?latitude=${LATITUDE}&longitude=${LONGITUDE}&email=${TEST_EMAIL}&serviceKey=${serviceKey}`
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.topic, null);
      assert.deepEqual(body.statements, []);
    },
    { seedStreets: true }
  ));

test('POST /road-alerts/statements creates a topic and a top-level statement, visible on a later GET', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const post = await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          body: 'Watch out for the pothole here.',
          latitude: LATITUDE,
          longitude: LONGITUDE,
          roadway: 'Pequawket Trl',
        }),
      });
      assert.equal(post.status, 200);
      const postBody = await post.json();
      assert.equal(postBody.statement.username, 'Alice R');
      assert.equal(postBody.statement.parentStatementId, null);

      const get = await fetch(
        `http://127.0.0.1:${port}/road-alerts/topic?latitude=${LATITUDE}&longitude=${LONGITUDE}&email=${TEST_EMAIL}&serviceKey=${serviceKey}`
      );
      const getBody = await get.json();
      assert.equal(getBody.topic.tlid, '78056932');
      assert.equal(getBody.statements.length, 1);
      assert.equal(getBody.statements[0].body, 'Watch out for the pothole here.');
      assert.deepEqual(getBody.statements[0].replies, []);
    },
    { seedStreets: true }
  ));

test('POST /road-alerts/statements rejects an account with no username set', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb, TEST_EMAIL, null);

      const response = await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          body: 'Anything.',
          latitude: LATITUDE,
          longitude: LONGITUDE,
        }),
      });

      assert.equal(response.status, 400);
    },
    { seedStreets: true }
  ));

test('POST /road-alerts/statements accepts a reply, and rejects a reply to a reply', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb);

      const top = await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          body: 'Watch out for the pothole here.',
          latitude: LATITUDE,
          longitude: LONGITUDE,
        }),
      }).then((r) => r.json());

      const reply = await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          body: 'Still there today.',
          parentStatementId: top.statement.id,
        }),
      });
      assert.equal(reply.status, 200);
      const replyBody = await reply.json();
      assert.equal(replyBody.topicId, top.topicId);

      const replyToReply = await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          serviceKey,
          body: 'A reply to a reply.',
          parentStatementId: replyBody.statement.id,
        }),
      });
      assert.equal(replyToReply.status, 400);

      const get = await fetch(
        `http://127.0.0.1:${port}/road-alerts/topic?latitude=${LATITUDE}&longitude=${LONGITUDE}&email=${TEST_EMAIL}&serviceKey=${serviceKey}`
      );
      const getBody = await get.json();
      assert.equal(getBody.statements[0].replies.length, 1);
      assert.equal(getBody.statements[0].replies[0].body, 'Still there today.');
    },
    { seedStreets: true }
  ));

test('GET and POST /road-alerts/topic and /road-alerts/statements reject a wrong or missing account', () =>
  withTestServer(
    async ({ port }) => {
      const get = await fetch(
        `http://127.0.0.1:${port}/road-alerts/topic?latitude=${LATITUDE}&longitude=${LONGITUDE}&email=nobody@example.com&serviceKey=mk_whatever`
      );
      assert.equal(get.status, 404);

      const post = await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nobody@example.com',
          serviceKey: 'mk_whatever',
          body: 'Anything.',
          latitude: LATITUDE,
          longitude: LONGITUDE,
        }),
      });
      assert.equal(post.status, 404);
    },
    { seedStreets: true }
  ));
