const fs = require('fs');

const { geocode } = require('./geocode');
const { ValidationError, NotFoundError } = require('./errors');

const MAX_ADDRESSES = 5000;

/**
 * Reads a plain-text file (one address per line) and geocodes each
 * line independently. A failure on one line doesn't stop the batch;
 * each result reports its own success/failure.
 */
function geocodeBatch(db, filePath, options = {}) {
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

  const content = fs.readFileSync(resolvedPath, 'utf8');
  const addresses = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (addresses.length === 0) {
    throw new ValidationError(`file has no addresses: ${resolvedPath}`);
  }
  if (addresses.length > MAX_ADDRESSES) {
    throw new ValidationError(
      `file has ${addresses.length} addresses; max is ${MAX_ADDRESSES}`
    );
  }

  return addresses.map((address) => {
    try {
      const result = geocode(db, address, options);
      return { address, success: true, ...result };
    } catch (err) {
      return { address, success: false, error: err.message };
    }
  });
}

module.exports = { geocodeBatch, MAX_ADDRESSES };
