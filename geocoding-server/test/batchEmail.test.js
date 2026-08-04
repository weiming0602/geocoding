const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { upsertUser, getUser } = require('../src/users');
const { withTestServer } = require('./helpers');

function writeTempAddressFile(contents) {
  const filePath = path.join(os.tmpdir(), `batch-email-addrs-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test('POST /geocode/batch/email streams the ZIP and records usage for a subscribed user', () =>
  withTestServer(async ({ port, usersDb }) => {
    await upsertUser(usersDb, 'alice@example.com', 10000);

    const addressFile = writeTempAddressFile(
      ['997 Pequawket Trl, Standish, ME 04091', '1 Nonexistent Way, Nowhere, ME 00000'].join('\n')
    );

    try {
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

      assert.equal((await getUser(usersDb, 'alice@example.com')).used_this_period, 2);
    } finally {
      fs.unlinkSync(addressFile);
    }
  }));

test('POST /geocode/batch/email rejects an unknown email with 404', () =>
  withTestServer(async ({ port }) => {
    const addressFile = writeTempAddressFile('997 Pequawket Trl, Standish, ME 04091');

    try {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: addressFile, email: 'nobody@example.com' }),
      });

      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error, /no active subscription/);
    } finally {
      fs.unlinkSync(addressFile);
    }
  }));

test('POST /geocode/batch/email rejects a request exceeding remaining quota with 429', () =>
  withTestServer(async ({ port, usersDb }) => {
    await upsertUser(usersDb, 'bob@example.com', 1); // quota of 1

    const addressFile = writeTempAddressFile(
      ['997 Pequawket Trl, Standish, ME 04091', '984 Pequawket Trl, Standish, ME 04091'].join('\n')
    );

    try {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: addressFile, email: 'bob@example.com' }),
      });

      assert.equal(response.status, 429);
      const body = await response.json();
      assert.match(body.error, /remain this period/);
      // Usage must not be recorded when the request is rejected.
      assert.equal((await getUser(usersDb, 'bob@example.com')).used_this_period, 0);
    } finally {
      fs.unlinkSync(addressFile);
    }
  }));

test('POST /geocode/batch/email rejects a malformed email with 400', () =>
  withTestServer(async ({ port }) => {
    const addressFile = writeTempAddressFile('997 Pequawket Trl, Standish, ME 04091');

    try {
      const response = await fetch(`http://127.0.0.1:${port}/geocode/batch/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: addressFile, email: 'not-an-email' }),
      });

      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /valid email/);
    } finally {
      fs.unlinkSync(addressFile);
    }
  }));
