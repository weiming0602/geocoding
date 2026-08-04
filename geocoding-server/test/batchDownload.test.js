const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { upsertUser } = require('../src/users');
const { withTestServer, parseZipEntries } = require('./helpers');

function writeTempAddressFile(contents) {
  const filePath = path.join(os.tmpdir(), `batch-download-addrs-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test('POST /geocode/batch/download streams a ZIP with results.csv and errors.csv', () =>
  withTestServer(async ({ port, usersDb }) => {
    const user = await upsertUser(usersDb, 'alice@example.com', 100);
    const addressFile = writeTempAddressFile(
      ['997 Pequawket Trl, Standish, ME 04091', '1 Nonexistent Way, Nowhere, ME 00000'].join('\n')
    );

    try {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          serviceKey: user.service_key,
          filePath: addressFile,
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/zip');
      assert.match(response.headers.get('content-disposition'), /batch-geocode-results\.zip/);
      assert.equal(response.headers.get('x-quota'), '2/100');

      const buffer = Buffer.from(await response.arrayBuffer());
      assert.ok(buffer.length > 0);
      // ZIP local file header magic number.
      assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');

      const entries = parseZipEntries(buffer);
      const resultsCsv = entries.find((e) => e.name === 'results.csv').content;
      const errorsCsv = entries.find((e) => e.name === 'errors.csv').content;

      // Confirms geocoding actually succeeded, not just that a well-formed
      // (possibly empty) ZIP came back -- this is what a missing
      // street_names fixture used to silently break.
      assert.match(resultsCsv, /997 Pequawket Trl, Standish, ME 04091/);
      assert.match(resultsCsv, /Pequawket Trl/);
      assert.match(errorsCsv, /1 Nonexistent Way, Nowhere, ME 00000/);
      assert.match(errorsCsv, /no street found/);
    } finally {
      fs.unlinkSync(addressFile);
    }
  }));

test('POST /geocode/batch/download with a missing file returns JSON 404', () =>
  withTestServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        serviceKey: 'mk_whatever',
        filePath: 'C:\\definitely\\not\\a\\real\\path.txt',
      }),
    });

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await response.json();
    assert.match(body.error, /file not found/);
  }));

test('POST /geocode/batch/download with a wrong service key returns JSON 401', () =>
  withTestServer(async ({ port, usersDb }) => {
    await upsertUser(usersDb, 'alice@example.com', 100);
    const addressFile = writeTempAddressFile('997 Pequawket Trl, Standish, ME 04091');

    try {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          serviceKey: 'mk_wrong',
          filePath: addressFile,
        }),
      });

      assert.equal(response.status, 401);
      const body = await response.json();
      assert.match(body.error, /service key/);
    } finally {
      fs.unlinkSync(addressFile);
    }
  }));

test('POST /geocode/batch/download rejects a batch exceeding remaining quota with 429', () =>
  withTestServer(async ({ port, usersDb }) => {
    const user = await upsertUser(usersDb, 'bob@example.com', 1); // quota of 1
    const addressFile = writeTempAddressFile(
      ['997 Pequawket Trl, Standish, ME 04091', '984 Pequawket Trl, Standish, ME 04091'].join('\n')
    );

    try {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'bob@example.com',
          serviceKey: user.service_key,
          filePath: addressFile,
        }),
      });

      assert.equal(response.status, 429);
      const body = await response.json();
      assert.match(body.error, /remain this period/);
    } finally {
      fs.unlinkSync(addressFile);
    }
  }));
