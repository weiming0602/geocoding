const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureRoadAlertsTopicsTable, findTopic, findOrCreateTopic } = require('../src/roadAlertsTopics');
const { makeUsersDb } = require('./helpers');

test('findOrCreateTopic creates a topic, then dedupes by tlid', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsTopicsTable(db);

  const first = await findOrCreateTopic(db, { tlid: '78056932', latitude: 43.83, longitude: -70.78, roadway: 'Pequawket Trl' });
  const second = await findOrCreateTopic(db, { tlid: '78056932', latitude: 43.83, longitude: -70.78, roadway: 'Pequawket Trl' });

  assert.equal(second.id, first.id);

  await db.close();
});

test('findOrCreateTopic dedupes by rounded coordinate when tlid is null', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsTopicsTable(db);

  const first = await findOrCreateTopic(db, { tlid: null, latitude: 43.123456, longitude: -70.654321, roadway: null });
  const second = await findOrCreateTopic(db, { tlid: null, latitude: 43.123457, longitude: -70.654322, roadway: null });

  assert.equal(second.id, first.id);

  await db.close();
});

test('findOrCreateTopic creates distinct topics for distinct locations', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsTopicsTable(db);

  const first = await findOrCreateTopic(db, { tlid: '78056932', latitude: 43.83, longitude: -70.78, roadway: 'Pequawket Trl' });
  const second = await findOrCreateTopic(db, { tlid: '99999999', latitude: 43.9, longitude: -71.0, roadway: 'Sebago Rd' });

  assert.notEqual(second.id, first.id);

  await db.close();
});

test('findTopic returns undefined when no topic exists yet, without creating one', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsTopicsTable(db);

  const found = await findTopic(db, { tlid: '78056932', latitude: 43.83, longitude: -70.78 });
  assert.equal(found, undefined);

  const { rows } = await db.query('SELECT count(*) FROM road_alerts_topics');
  assert.equal(Number(rows[0].count), 0);

  await db.close();
});
