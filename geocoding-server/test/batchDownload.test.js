const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { parseZipEntries } = require('./helpers');

function makeTempDbFile() {
  const dbPath = path.join(os.tmpdir(), `batch-download-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = new Database(dbPath);
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
    CREATE TABLE street_names (
      id INTEGER PRIMARY KEY,
      tlid TEXT NOT NULL,
      fullname TEXT NOT NULL,
      paflag TEXT,
      zipl TEXT,
      zipr TEXT,
      state TEXT,
      state_abbr TEXT
    );
  `);
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, geometry)
     VALUES (12, '78056932', 'Pequawket Trl', '988', '998', '979', '991', '04091', '04091',
             'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)')`
  ).run();
  // candidateStreets() (src/geocode.js) always matches names via
  // street_names, not streets.fullname directly -- every streets row needs
  // its own fullname registered here or matching finds nothing. state/
  // state_abbr must be populated too: the test address carries a state
  // ("...ME 04091"), which filters on street_names.state_abbr.
  db.prepare(
    `INSERT INTO street_names (tlid, fullname, paflag, zipl, zipr, state, state_abbr)
     VALUES ('78056932', 'Pequawket Trl', 'P', '04091', '04091', 'Maine', 'ME')`
  ).run();
  db.close();
  return dbPath;
}

function writeTempAddressFile(contents) {
  const filePath = path.join(os.tmpdir(), `batch-download-addrs-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test('POST /geocode/batch/download streams a ZIP with results.csv and errors.csv', async () => {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  delete require.cache[require.resolve('../src/server')];
  const { app, db } = require('../src/server');

  const addressFile = writeTempAddressFile(
    ['997 Pequawket Trl, Standish, ME 04091', '1 Nonexistent Way, Nowhere, ME 00000'].join('\n')
  );

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: addressFile }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition'), /batch-geocode-results\.zip/);

    const buffer = Buffer.from(await response.arrayBuffer());
    assert.ok(buffer.length > 0);
    // ZIP local file header magic number.
    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');

    const entries = parseZipEntries(buffer);
    const resultsCsv = entries.find((e) => e.name === 'results.csv').content;
    const errorsCsv = entries.find((e) => e.name === 'errors.csv').content;

    // Confirms geocoding actually succeeded, not just that a well-formed
    // (possibly empty) ZIP came back -- this is what the missing
    // street_names fixture above used to silently break.
    assert.match(resultsCsv, /997 Pequawket Trl, Standish, ME 04091/);
    assert.match(resultsCsv, /Pequawket Trl/);
    assert.match(errorsCsv, /1 Nonexistent Way, Nowhere, ME 00000/);
    assert.match(errorsCsv, /no street found/);
  } finally {
    server.close();
    db.close();
    fs.unlinkSync(addressFile);
    fs.unlinkSync(dbPath);
    delete process.env.GEOCODING_DB_PATH;
  }
});

test('POST /geocode/batch/download with a missing file returns JSON 404', async () => {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  delete require.cache[require.resolve('../src/server')];
  const { app, db } = require('../src/server');

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'C:\\definitely\\not\\a\\real\\path.txt' }),
    });

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await response.json();
    assert.match(body.error, /file not found/);
  } finally {
    server.close();
    db.close();
    fs.unlinkSync(dbPath);
    delete process.env.GEOCODING_DB_PATH;
  }
});
