const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { geocode } = require('../src/geocode');
const { ValidationError, NotFoundError, OutOfRangeError } = require('../src/errors');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE streets (
      id INTEGER PRIMARY KEY,
      tlid TEXT,
      fullname TEXT,
      lfromadd TEXT,
      ltoadd TEXT,
      rfromadd TEXT,
      rtoadd TEXT,
      zipl TEXT,
      zipr TEXT,
      geometry TEXT
    );
  `);
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, geometry)
     VALUES (12, '78056932', 'Pequawket Trl', '988', '998', '979', '991', '04091', '04091',
             'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)')`
  ).run();
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, geometry)
     VALUES (1, '78060165', 'Sebago Rd', '', '', '', '', '04074', '04074',
             'LINESTRING (-70.748418 43.876127, -70.750996 43.878619)')`
  ).run();
  // A second segment of the same named street/ZIP, covering a different
  // address sub-range (real streets are split into many such segments).
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, geometry)
     VALUES (14, '78012506', 'Pequawket Trl', '700', '738', '701', '721', '04091', '04091',
             'LINESTRING (-70.79 43.83, -70.795 43.835)')`
  ).run();
  return db;
}

test('odd house number uses the left range and offsets left', () => {
  const db = makeDb();
  const result = geocode(db, '997 Pequawket Trl, Standish, ME 04091', { offsetFeet: 5 });
  assert.equal(result.rangeSide, 'left');
  assert.equal(result.offsetSide, 'left');
  assert.equal(result.match.id, 12);
  db.close();
});

test('even house number uses the right range and offsets right', () => {
  const db = makeDb();
  const result = geocode(db, '984 Pequawket Trl, Standish, ME 04091', { offsetFeet: 5 });
  assert.equal(result.rangeSide, 'right');
  assert.equal(result.offsetSide, 'right');
  assert.equal(result.match.id, 12);
  db.close();
});

test('unmatched street/zip throws NotFoundError', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '997 Nonexistent Rd, Standish, ME 99999'),
    NotFoundError
  );
  db.close();
});

test('street with no address range on the requested side throws OutOfRangeError', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '55 Sebago Rd, Windham, ME 04074'),
    OutOfRangeError
  );
  db.close();
});

test('picks the segment whose range actually contains the number, among several', () => {
  const db = makeDb();
  const result = geocode(db, '997 Pequawket Trl, Standish, ME 04091');
  assert.equal(result.match.id, 12);

  const other = geocode(db, '721 Pequawket Trl, Standish, ME 04091', { offsetFeet: 0 });
  assert.equal(other.match.id, 14);
  db.close();
});

test('number outside the matched range throws OutOfRangeError', () => {
  const db = makeDb();
  assert.throws(
    () => geocode(db, '57 Pequawket Trl, Standish, ME 04091'),
    OutOfRangeError
  );
  db.close();
});

test('invalid address throws ValidationError', () => {
  const db = makeDb();
  assert.throws(() => geocode(db, ''), ValidationError);
  db.close();
});
