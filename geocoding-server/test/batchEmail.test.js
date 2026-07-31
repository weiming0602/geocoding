const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { upsertUser, getUser } = require('../src/users');

function makeTempDbFile() {
  const dbPath = path.join(os.tmpdir(), `batch-email-test-${Date.now()}-${Math.random()}.sqlite`);
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
  `);
  db.prepare(
    `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, geometry)
     VALUES (12, '78056932', 'Pequawket Trl', '988', '998', '979', '991', '04091', '04091',
             'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)')`
  ).run();
  db.close();
  return dbPath;
}

function writeTempAddressFile(contents) {
  const filePath = path.join(os.tmpdir(), `batch-email-addrs-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function freshServer() {
  delete require.cache[require.resolve('../src/server')];
  return require('../src/server');
}

test('POST /geocode/batch/email streams the ZIP and records usage for a subscribed user', async () => {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  process.env.USERS_DB_PATH = ':memory:';
  const { app, db, usersDb } = freshServer();
  upsertUser(usersDb, 'alice@example.com', 10000);

  const addressFile = writeTempAddressFile(
    ['997 Pequawket Trl, Standish, ME 04091', '1 Nonexistent Way, Nowhere, ME 00000'].join('\n')
  );

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: addressFile, email: 'alice@example.com' }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('x-quota'), '2/10000');
    assert.equal(response.headers.get('x-email-delivery'), 'stubbed');

    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');

    assert.equal(getUser(usersDb, 'alice@example.com').used_this_period, 2);
  } finally {
    server.close();
    db.close();
    usersDb.close();
    fs.unlinkSync(addressFile);
    fs.unlinkSync(dbPath);
    delete process.env.GEOCODING_DB_PATH;
    delete process.env.USERS_DB_PATH;
  }
});

test('POST /geocode/batch/email rejects an unknown email with 404', async () => {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  process.env.USERS_DB_PATH = ':memory:';
  const { app, db, usersDb } = freshServer();

  const addressFile = writeTempAddressFile('997 Pequawket Trl, Standish, ME 04091');

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: addressFile, email: 'nobody@example.com' }),
    });

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.match(body.error, /no active subscription/);
  } finally {
    server.close();
    db.close();
    usersDb.close();
    fs.unlinkSync(addressFile);
    fs.unlinkSync(dbPath);
    delete process.env.GEOCODING_DB_PATH;
    delete process.env.USERS_DB_PATH;
  }
});

test('POST /geocode/batch/email rejects a request exceeding remaining quota with 429', async () => {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  process.env.USERS_DB_PATH = ':memory:';
  const { app, db, usersDb } = freshServer();
  upsertUser(usersDb, 'bob@example.com', 1); // quota of 1

  const addressFile = writeTempAddressFile(
    ['997 Pequawket Trl, Standish, ME 04091', '984 Pequawket Trl, Standish, ME 04091'].join('\n')
  );

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: addressFile, email: 'bob@example.com' }),
    });

    assert.equal(response.status, 429);
    const body = await response.json();
    assert.match(body.error, /remain this period/);
    // Usage must not be recorded when the request is rejected.
    assert.equal(getUser(usersDb, 'bob@example.com').used_this_period, 0);
  } finally {
    server.close();
    db.close();
    usersDb.close();
    fs.unlinkSync(addressFile);
    fs.unlinkSync(dbPath);
    delete process.env.GEOCODING_DB_PATH;
    delete process.env.USERS_DB_PATH;
  }
});

test('POST /geocode/batch/email rejects a malformed email with 400', async () => {
  const dbPath = makeTempDbFile();
  process.env.GEOCODING_DB_PATH = dbPath;
  process.env.USERS_DB_PATH = ':memory:';
  const { app, db, usersDb } = freshServer();

  const addressFile = writeTempAddressFile('997 Pequawket Trl, Standish, ME 04091');

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: addressFile, email: 'not-an-email' }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /valid email/);
  } finally {
    server.close();
    db.close();
    usersDb.close();
    fs.unlinkSync(addressFile);
    fs.unlinkSync(dbPath);
    delete process.env.GEOCODING_DB_PATH;
    delete process.env.USERS_DB_PATH;
  }
});
