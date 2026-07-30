const Database = require('better-sqlite3');

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
      state TEXT,
      state_abbr TEXT,
      geometry TEXT
    );
  `);
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr, geometry)
     VALUES (12, '78056932', 'Pequawket Trl', '988', '998', '979', '991', '04091', '04091', 'Maine', 'ME',
             'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)')`
  ).run();
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr, geometry)
     VALUES (1, '78060165', 'Sebago Rd', '', '', '', '', '04074', '04074', 'Maine', 'ME',
             'LINESTRING (-70.748418 43.876127, -70.750996 43.878619)')`
  ).run();
  // A second segment of the same named street/ZIP, covering a different
  // address sub-range (real streets are split into many such segments).
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr, geometry)
     VALUES (14, '78012506', 'Pequawket Trl', '700', '738', '701', '721', '04091', '04091', 'Maine', 'ME',
             'LINESTRING (-70.79 43.83, -70.795 43.835)')`
  ).run();
  // Same fullname+zip as id=12/14 but in a different state, to test that
  // state disambiguates when everything else collides.
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr, geometry)
     VALUES (99, '99999999', 'Pequawket Trl', '100', '198', '101', '199', '04091', '04091', 'New Hampshire', 'NH',
             'LINESTRING (-71.0 43.9, -71.01 43.91)')`
  ).run();
  return db;
}

module.exports = { makeDb };
