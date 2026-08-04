const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { geocodeBatch, readAddressContent } = require('../src/batchGeocode');
const { ValidationError, NotFoundError } = require('../src/errors');
const { makeDb } = require('./helpers');

function writeTempFile(contents) {
  const filePath = path.join(os.tmpdir(), `batch-geocode-test-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test('geocodes each line, mixing successes and failures', async () => {
  const db = await makeDb();
  const filePath = writeTempFile(
    [
      '997 Pequawket Trl, Standish, ME 04091',
      '984 Pequawket Trl, Standish, ME 04091',
      '123 Nonexistent Way, Nowhere, ME 99999',
      '',
      '  ',
    ].join('\n')
  );

  const results = await geocodeBatch(db, filePath, { offsetFeet: 5 });

  assert.equal(results.length, 3); // blank lines are skipped
  assert.equal(results[0].success, true);
  assert.equal(results[0].match.id, 12);
  assert.equal(results[1].success, true);
  assert.equal(results[1].rangeSide, 'right');
  assert.equal(results[2].success, false);
  assert.match(results[2].error, /no street found/);

  fs.unlinkSync(filePath);
  await db.close();
});

test('missing file throws NotFoundError', async () => {
  const db = await makeDb();
  await assert.rejects(
    () => geocodeBatch(db, 'C:\\definitely\\not\\a\\real\\path.txt'),
    NotFoundError
  );
  await db.close();
});

test('directory path throws ValidationError', async () => {
  const db = await makeDb();
  await assert.rejects(() => geocodeBatch(db, os.tmpdir()), ValidationError);
  await db.close();
});

test('empty file throws ValidationError', async () => {
  const db = await makeDb();
  const filePath = writeTempFile('\n\n  \n');
  await assert.rejects(() => geocodeBatch(db, filePath), ValidationError);
  fs.unlinkSync(filePath);
  await db.close();
});

test('non-string filePath throws ValidationError', async () => {
  const db = await makeDb();
  await assert.rejects(() => geocodeBatch(db, undefined), ValidationError);
  await assert.rejects(() => geocodeBatch(db, 42), ValidationError);
  await db.close();
});

test('accepts files well beyond the old 5000-address cap', async () => {
  const db = await makeDb();
  const filePath = writeTempFile(
    Array.from({ length: 8000 }, () => '1 Some St, Town, ME 00000').join('\n')
  );
  const results = await geocodeBatch(db, filePath);
  assert.equal(results.length, 8000);
  fs.unlinkSync(filePath);
  await db.close();
});

test('readAddressContent parses lines the same way as readAddressLines, skipping blanks', () => {
  const addresses = readAddressContent(
    ['997 Pequawket Trl, Standish, ME 04091', '', '  ', '984 Pequawket Trl, Standish, ME 04091'].join(
      '\n'
    )
  );
  assert.deepEqual(addresses, [
    '997 Pequawket Trl, Standish, ME 04091',
    '984 Pequawket Trl, Standish, ME 04091',
  ]);
});

test('readAddressContent rejects blank content', () => {
  assert.throws(() => readAddressContent('\n\n  \n'), ValidationError);
  assert.throws(() => readAddressContent(''), ValidationError);
});

test('readAddressContent rejects non-string content', () => {
  assert.throws(() => readAddressContent(undefined), ValidationError);
  assert.throws(() => readAddressContent(42), ValidationError);
});
