const fs = require('fs');

const { geocode } = require('./geocode');
const { ValidationError, NotFoundError } = require('./errors');

/** Splits raw file content (one address per line) into a list of addresses. */
function parseAddresses(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Reads and validates a plain-text file (one address per line) into a list of addresses. */
function readAddressLines(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ValidationError('filePath must be a non-empty string');
  }
  const resolvedPath = filePath.trim();

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    throw new NotFoundError(`file not found: ${resolvedPath}`);
  }
  if (!stat.isFile()) {
    throw new ValidationError(`not a file: ${resolvedPath}`);
  }

  const addresses = parseAddresses(fs.readFileSync(resolvedPath, 'utf8'));
  if (addresses.length === 0) {
    throw new ValidationError(`file has no addresses: ${resolvedPath}`);
  }
  return addresses;
}

/**
 * Validates raw file content (one address per line) uploaded directly in the
 * request body -- the path taken when a client (e.g. a phone, which has no
 * filesystem path the server can read) picks a file on-device and sends its
 * contents instead of a server-local filePath.
 */
function readAddressContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ValidationError('fileContent must be a non-empty string');
  }

  const addresses = parseAddresses(content);
  if (addresses.length === 0) {
    throw new ValidationError('fileContent has no addresses');
  }
  return addresses;
}

/**
 * Geocodes each address independently. A failure on one line doesn't
 * stop the batch; each result reports its own success/failure. No cap
 * on address count: callers accept that a large enough batch will tie
 * up the server (synchronous SQLite queries, single Node thread) for
 * however long it takes to run, since nothing here queues or rate-limits.
 */
function geocodeAddressList(db, addresses, options = {}) {
  return addresses.map((address) => {
    try {
      const result = geocode(db, address, options);
      return { address, success: true, ...result };
    } catch (err) {
      return { address, success: false, error: err.message };
    }
  });
}

function geocodeBatch(db, filePath, options = {}) {
  const addresses = readAddressLines(filePath);
  return geocodeAddressList(db, addresses, options);
}

module.exports = {
  geocodeBatch,
  geocodeAddressList,
  readAddressLines,
  readAddressContent,
};
