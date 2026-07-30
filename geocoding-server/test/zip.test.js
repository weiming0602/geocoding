const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const { buildZip } = require('../src/zip');

/** Parses local file header entries back out of a ZIP built by buildZip(). */
function parseZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    entries.push({ name, content: content.toString('utf8') });
    offset = dataStart + compressedSize;
  }
  return entries;
}

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
