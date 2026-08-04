const test = require('node:test');
const assert = require('node:assert/strict');

const { withTestServer } = require('./helpers');

// Covers the fileContent path added for clients with no server-reachable
// filesystem path (e.g. a phone that picked a file on-device) -- see
// resolveAddresses() in server.js and readAddressContent() in batchGeocode.js.

test('POST /geocode/batch with fileContent geocodes the same as filePath', () =>
  withTestServer(async ({ port }) => {
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
  withTestServer(async ({ port }) => {
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
  withTestServer(async ({ port }) => {
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
  withTestServer(async ({ port }) => {
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
  withTestServer(async ({ port }) => {
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
