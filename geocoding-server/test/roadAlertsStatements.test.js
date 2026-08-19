const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureRoadAlertsStatementsTable, insertStatement, getStatementsForTopic } = require('../src/roadAlertsStatements');
const { ValidationError } = require('../src/errors');
const { makeUsersDb } = require('./helpers');

test('insertStatement inserts a top-level statement', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsStatementsTable(db);

  const statement = await insertStatement(db, {
    topicId: 1,
    parentStatementId: null,
    email: 'alice@example.com',
    username: 'Alice R',
    body: 'Watch out for the pothole here.',
  });

  assert.equal(statement.topic_id, 1);
  assert.equal(statement.parent_statement_id, null);
  assert.equal(statement.username, 'Alice R');

  await db.close();
});

test('insertStatement accepts a reply to a top-level statement', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsStatementsTable(db);

  const parent = await insertStatement(db, {
    topicId: 1,
    parentStatementId: null,
    email: 'alice@example.com',
    username: 'Alice R',
    body: 'Watch out for the pothole here.',
  });
  const reply = await insertStatement(db, {
    topicId: 1,
    parentStatementId: parent.id,
    email: 'bob@example.com',
    username: 'Bob T',
    body: 'Still there as of today.',
  });

  assert.equal(reply.parent_statement_id, parent.id);

  await db.close();
});

test('insertStatement rejects a reply to a reply', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsStatementsTable(db);

  const parent = await insertStatement(db, {
    topicId: 1,
    parentStatementId: null,
    email: 'alice@example.com',
    username: 'Alice R',
    body: 'Watch out for the pothole here.',
  });
  const reply = await insertStatement(db, {
    topicId: 1,
    parentStatementId: parent.id,
    email: 'bob@example.com',
    username: 'Bob T',
    body: 'Still there as of today.',
  });

  await assert.rejects(
    () =>
      insertStatement(db, {
        topicId: 1,
        parentStatementId: reply.id,
        email: 'carol@example.com',
        username: 'Carol N',
        body: 'A reply to a reply.',
      }),
    ValidationError
  );

  await db.close();
});

test('insertStatement rejects a reply to a nonexistent statement', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsStatementsTable(db);

  await assert.rejects(
    () =>
      insertStatement(db, {
        topicId: 1,
        parentStatementId: 999999,
        email: 'alice@example.com',
        username: 'Alice R',
        body: 'A reply to nothing.',
      }),
    ValidationError
  );

  await db.close();
});

test('getStatementsForTopic returns top-level statements with their own flat replies', async () => {
  const db = await makeUsersDb();
  await ensureRoadAlertsStatementsTable(db);

  const first = await insertStatement(db, {
    topicId: 1,
    parentStatementId: null,
    email: 'alice@example.com',
    username: 'Alice R',
    body: 'First statement.',
  });
  const second = await insertStatement(db, {
    topicId: 1,
    parentStatementId: null,
    email: 'bob@example.com',
    username: 'Bob T',
    body: 'Second statement.',
  });
  await insertStatement(db, {
    topicId: 1,
    parentStatementId: first.id,
    email: 'carol@example.com',
    username: 'Carol N',
    body: 'Reply to the first.',
  });
  // A statement on a different topic must not show up here.
  await insertStatement(db, {
    topicId: 2,
    parentStatementId: null,
    email: 'dave@example.com',
    username: 'Dave K',
    body: 'Unrelated topic.',
  });

  const statements = await getStatementsForTopic(db, 1);
  assert.equal(statements.length, 2);
  assert.equal(statements[0].id, first.id);
  assert.equal(statements[0].replies.length, 1);
  assert.equal(statements[0].replies[0].body, 'Reply to the first.');
  assert.equal(statements[1].id, second.id);
  assert.equal(statements[1].replies.length, 0);

  await db.close();
});
