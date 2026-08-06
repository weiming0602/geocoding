const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureFeedbackTable, submitFeedback, deleteOldFeedback } = require('../src/feedback');
const { makeUsersDb } = require('./helpers');

test('submitFeedback records name/email/message, all but message optional', async () => {
  const db = await makeUsersDb();
  await ensureFeedbackTable(db);

  const withAll = await submitFeedback(db, {
    name: 'Vasily',
    email: 'vasily@example.com',
    message: 'Any plans for Vermont?',
  });
  assert.equal(withAll.name, 'Vasily');
  assert.equal(withAll.email, 'vasily@example.com');
  assert.equal(withAll.message, 'Any plans for Vermont?');
  assert.ok(withAll.created_at);

  const anonymous = await submitFeedback(db, { name: null, email: null, message: 'just a note' });
  assert.equal(anonymous.name, null);
  assert.equal(anonymous.email, null);
  assert.equal(anonymous.message, 'just a note');

  await db.close();
});

test('deleteOldFeedback only deletes rows older than the given number of days', async () => {
  const db = await makeUsersDb();
  await ensureFeedbackTable(db);

  const recent = await submitFeedback(db, { name: null, email: null, message: 'recent' });
  const old = await submitFeedback(db, { name: null, email: null, message: 'old' });
  await db.query('UPDATE feedback SET created_at = now() - interval \'100 days\' WHERE id = $1', [
    old.id,
  ]);

  const deletedCount = await deleteOldFeedback(db, 90);
  assert.equal(deletedCount, 1);

  const { rows } = await db.query('SELECT id FROM feedback ORDER BY id');
  assert.deepEqual(
    rows.map((r) => r.id),
    [recent.id]
  );

  await db.close();
});
