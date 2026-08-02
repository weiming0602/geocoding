const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildZip } = require('../src/zip');
const { parseZipEntries } = require('./helpers');

test('buildZip round-trips entries (self-parsed)', () => {
  const zipBuffer = buildZip([
    { name: 'results.csv', content: 'address,latitude\r\n1 Main St,43.5\r\n' },
    { name: 'errors.csv', content: 'address,error\r\n' },
  ]);

  assert.equal(zipBuffer.subarray(0, 2).toString('ascii'), 'PK');

  const entries = parseZipEntries(zipBuffer);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'results.csv');
  assert.equal(entries[0].content, 'address,latitude\r\n1 Main St,43.5\r\n');
  assert.equal(entries[1].name, 'errors.csv');
  assert.equal(entries[1].content, 'address,error\r\n');
});

test('buildZip produces an archive Windows can actually extract', () => {
  const zipBuffer = buildZip([
    { name: 'results.csv', content: 'address,latitude\r\n1 Main St,43.5\r\n' },
    { name: 'errors.csv', content: 'address,error\r\n"a, b",oops\r\n' },
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
  const zipPath = path.join(tmpDir, 'archive.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  fs.writeFileSync(zipPath, zipBuffer);

  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ]);

    const resultsContent = fs.readFileSync(path.join(extractDir, 'results.csv'), 'utf8');
    const errorsContent = fs.readFileSync(path.join(extractDir, 'errors.csv'), 'utf8');

    assert.equal(resultsContent, 'address,latitude\r\n1 Main St,43.5\r\n');
    assert.equal(errorsContent, 'address,error\r\n"a, b",oops\r\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
