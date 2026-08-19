const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';

/** Registers a Road Alerts account, sets a username, returns its service key. */
async function registerTestAccount(usersDb, email, username) {
  const { registerAccount, updateUsername } = require('../src/roadAlertsAccounts');
  const account = await registerAccount(usersDb, email);
  await updateUsername(usersDb, email, username);
  return account.service_key;
}

test('GET /road-alerts/notifications returns 0 with no replies', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const serviceKey = await registerTestAccount(usersDb, ALICE_EMAIL, 'Alice R');

      const response = await fetch(
        `http://127.0.0.1:${port}/road-alerts/notifications?email=${ALICE_EMAIL}&serviceKey=${serviceKey}`
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.replyCount, 0);
    },
    { seedStreets: false }
  ));

test('GET /road-alerts/notifications counts a reply from someone else, and marking viewed resets it', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      const aliceKey = await registerTestAccount(usersDb, ALICE_EMAIL, 'Alice R');
      const bobKey = await registerTestAccount(usersDb, BOB_EMAIL, 'Bob T');

      const top = await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: ALICE_EMAIL,
          serviceKey: aliceKey,
          body: 'A statement from Alice.',
          latitude: 43.8,
          longitude: -70.5,
        }),
      }).then((r) => r.json());

      // Alice replying to her own statement must not count.
      await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: ALICE_EMAIL,
          serviceKey: aliceKey,
          body: 'Following up on my own post.',
          parentStatementId: top.statement.id,
        }),
      });

      // Bob's reply must count.
      await fetch(`http://127.0.0.1:${port}/road-alerts/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: BOB_EMAIL,
          serviceKey: bobKey,
          body: 'A reply from Bob.',
          parentStatementId: top.statement.id,
        }),
      });

      const afterReplies = await fetch(
        `http://127.0.0.1:${port}/road-alerts/notifications?email=${ALICE_EMAIL}&serviceKey=${aliceKey}`
      ).then((r) => r.json());
      assert.equal(afterReplies.replyCount, 1);

      const markViewed = await fetch(`http://127.0.0.1:${port}/road-alerts/notifications/viewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ALICE_EMAIL, serviceKey: aliceKey }),
      });
      assert.equal(markViewed.status, 200);

      const afterViewing = await fetch(
        `http://127.0.0.1:${port}/road-alerts/notifications?email=${ALICE_EMAIL}&serviceKey=${aliceKey}`
      ).then((r) => r.json());
      assert.equal(afterViewing.replyCount, 0);
    },
    { seedStreets: true }
  ));

test('GET and POST /road-alerts/notifications reject a wrong service key', () =>
  withTestServer(
    async ({ port, usersDb }) => {
      await registerTestAccount(usersDb, ALICE_EMAIL, 'Alice R');

      const get = await fetch(
        `http://127.0.0.1:${port}/road-alerts/notifications?email=${ALICE_EMAIL}&serviceKey=mk_wrong`
      );
      assert.equal(get.status, 401);

      const post = await fetch(`http://127.0.0.1:${port}/road-alerts/notifications/viewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ALICE_EMAIL, serviceKey: 'mk_wrong' }),
      });
      assert.equal(post.status, 401);
    },
    { seedStreets: false }
  ));
