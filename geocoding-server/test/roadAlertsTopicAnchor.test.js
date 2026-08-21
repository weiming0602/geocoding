const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTlid } = require('../src/roadAlertsTopicAnchor');
const { makeDb } = require('./helpers');

test('resolveTlid returns the tlid of the nearest fixture street', async () => {
  const db = await makeDb();
  // Same known point as reverseGeocode.test.js's round-trip case --
  // 997 Pequawket Trl, id=12, tlid=78056932.
  const tlid = await resolveTlid(db, 43.834390719401604, -70.77854947339969);
  assert.equal(tlid, '78056932');
  await db.close();
});

test('resolveTlid returns null far from any fixture street, instead of throwing', async () => {
  const db = await makeDb();
  const tlid = await resolveTlid(db, 0, 0);
  assert.equal(tlid, null);
  await db.close();
});
