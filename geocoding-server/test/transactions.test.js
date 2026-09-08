const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureTransactionsTable,
  recordTransaction,
  listTransactions,
  getUnnotifiedTransactions,
  markTransactionsNotified,
} = require('../src/transactions');
const { makeUsersDb } = require('./helpers');

test('recordTransaction records a purchase, listTransactions returns newest first', async () => {
  const db = await makeUsersDb();
  await ensureTransactionsTable(db);

  const first = await recordTransaction(db, {
    email: 'alice@example.com',
    orderId: 'ORDER-1',
    addressCount: 1000,
    priceCents: 1500,
    tier: 1000,
  });
  assert.equal(first.email, 'alice@example.com');
  assert.equal(first.order_id, 'ORDER-1');
  assert.equal(first.address_count, 1000);
  assert.equal(first.price_cents, 1500);
  assert.equal(first.tier, 1000);
  assert.ok(first.created_at);
  assert.equal(first.notified_at, null);

  const second = await recordTransaction(db, {
    email: 'bob@example.com',
    orderId: 'ORDER-2',
    addressCount: 500,
    priceCents: 900,
    tier: 500,
  });

  const listed = await listTransactions(db);
  assert.deepEqual(
    listed.map((t) => t.id),
    [second.id, first.id]
  );

  await db.close();
});

test('listTransactions respects the limit option', async () => {
  const db = await makeUsersDb();
  await ensureTransactionsTable(db);

  for (let i = 0; i < 5; i++) {
    await recordTransaction(db, {
      email: `user${i}@example.com`,
      orderId: `ORDER-${i}`,
      addressCount: 100,
      priceCents: 500,
      tier: 100,
    });
  }

  const listed = await listTransactions(db, { limit: 2 });
  assert.equal(listed.length, 2);

  await db.close();
});

test('getUnnotifiedTransactions only returns rows with no notified_at, markTransactionsNotified clears them', async () => {
  const db = await makeUsersDb();
  await ensureTransactionsTable(db);

  const a = await recordTransaction(db, {
    email: 'alice@example.com',
    orderId: 'ORDER-A',
    addressCount: 1000,
    priceCents: 1500,
    tier: 1000,
  });
  const b = await recordTransaction(db, {
    email: 'bob@example.com',
    orderId: 'ORDER-B',
    addressCount: 500,
    priceCents: 900,
    tier: 500,
  });

  const pendingBefore = await getUnnotifiedTransactions(db);
  assert.deepEqual(
    pendingBefore.map((t) => t.id),
    [a.id, b.id]
  );

  await markTransactionsNotified(db, [a.id]);

  const pendingAfter = await getUnnotifiedTransactions(db);
  assert.deepEqual(
    pendingAfter.map((t) => t.id),
    [b.id]
  );

  // Transactions are financial records -- marking one notified must
  // never delete it, only clear it from the pending-digest query.
  const all = await listTransactions(db);
  assert.equal(all.length, 2);

  await db.close();
});

test('markTransactionsNotified is a no-op given an empty array', async () => {
  const db = await makeUsersDb();
  await ensureTransactionsTable(db);
  await markTransactionsNotified(db, []);
  await db.close();
});
