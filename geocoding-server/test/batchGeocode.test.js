const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { geocodeBatch, MAX_ADDRESSES } = require('../src/batchGeocode');
const { ValidationError, NotFoundError } = require('../src/errors');
const { makeDb } = require('./helpers');

function writeTempFile(contents) {
  const filePath = path.join(os.tmpdir(), `batch-geocode-test-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test('geocodes each line, mixing successes and failures', () => {
  const db = makeDb();
  const filePath = writeTempFile(
    [
      '997 Pequawket Trl, Standish, ME 04091',
      '984 Pequawket Trl, Standish, ME 04091',
      '123 Nonexistent Way, Nowhere, ME 99999',
      '',
      '  ',
    ].join('\n')
  );

  const results = geocodeBatch(db, filePath, { offsetFeet: 5 });

  assert.equal(results.length, 3); // blank lines are skipped
  assert.equal(results[0].success, true);
  assert.equal(results[0].match.id, 12);
  assert.equal(results[1].success, true);
  assert.equal(results[1].rangeSide, 'right');
  assert.equal(results[2].success, false);
  assert.match(results[2].error, /no street found/);

  fs.unlinkSync(filePath);
  db.close();
});

test('missing file throws NotFoundError', () => {
  const db = makeDb();
  assert.throws(
    () => geocodeBatch(db, 'C:\\definitely\\not\\a\\real\\path.txt'),
    NotFoundError
  );
  db.close();
});

test('directory path throws ValidationError', () => {
  const db = makeDb();
  assert.throws(() => geocodeBatch(db, os.tmpdir()), ValidationError);
  db.close();
});

test('empty file throws ValidationError', () => {
  const db = makeDb();
  const filePath = writeTempFile('\n\n  \n');
  assert.throws(() => geocodeBatch(db, filePath), ValidationError);
  fs.unlinkSync(filePath);
  db.close();
});

test('non-string filePath throws ValidationError', () => {
  const db = makeDb();
  assert.throws(() => geocodeBatch(db, undefined), ValidationError);
  assert.throws(() => geocodeBatch(db, 42), ValidationError);
  db.close();
});

test('rejects files with more than MAX_ADDRESSES lines', () => {
  const db = makeDb();
  const filePath = writeTempFile(
    Array.from({ length: MAX_ADDRESSES + 1 }, () => '1 Some St, Town, ME 00000').join('\n')
  );
  assert.throws(() => geocodeBatch(db, filePath), ValidationError);
  fs.unlinkSync(filePath);
  db.close();
});
