const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// Covers the fileContent path added for clients with no server-reachable
// filesystem path (e.g. a phone that picked a file on-device) -- see
// resolveAddresses() in server.js and readAddressContent() in batchGeocode.js.

function makeTempDbFile() {
  const dbPath = path.join(os.tmpdir(), `batch-content-test-${Date.now()}-${Math.random()}.sqlite`);
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
  // state_abbr must be populated too: addresses carrying a state (e.g.
  // "...ME 04091") filter on street_names.state_abbr, not streets'.
  db.prepare(
    `INSERT INTO street_names (tlid, fullname, paflag, zipl, zipr, state, state_abbr)
     VALUES ('78056932', 'Pequawket Trl', 'P', '04091', '04091', 'Maine', 'ME')`
  ).run();
  db.close();
  return dbPath;
}

function withServer(callback) {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  delete require.cache[require.resolve('../src/server')];
  const { app, db } = require('../src/server');
  const server = app.listen(0);
  const { port } = server.address();

  return Promise.resolve(callback(port))
    .finally(() => {
      server.close();
      db.close();
      fs.unlinkSync(dbPath);
      delete process.env.GEOCODING_DB_PATH;
    });
}

test('POST /geocode/batch with fileContent geocodes the same as filePath', () =>
  withServer(async (port) => {
    const fileContent = [
      '997 Pequawket Trl, Standish, ME 04091',
      '1 Nonexistent Way, Nowhere, ME 00000',
    ].join('\n');

    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileContent }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].success, true);
    assert.equal(body.results[1].success, false);
  }));

test('POST /geocode/batch with blank fileContent returns JSON 400', () =>
  withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileContent: '\n\n  \n' }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /fileContent/);
  }));

test('POST /geocode/batch with neither filePath nor fileContent returns JSON 400', () =>
  withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /filePath/);
  }));

test('POST /geocode/batch/download with fileContent streams a ZIP', () =>
  withServer(async (port) => {
    const fileContent = '997 Pequawket Trl, Standish, ME 04091';

    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileContent }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');
  }));

test('fileContent takes priority when both filePath and fileContent are present', () =>
  withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: 'C:\\definitely\\not\\a\\real\\path.txt',
        fileContent: '997 Pequawket Trl, Standish, ME 04091',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].success, true);
  }));
