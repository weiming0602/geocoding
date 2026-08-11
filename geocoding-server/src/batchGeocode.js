const fs = require('fs');
const os = require('os');
const path = require('path');

const { geocode } = require('./geocode');
const { ValidationError, NotFoundError } = require('./errors');

/** Splits raw file content (one address per line) into a list of addresses. */
function parseAddresses(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// `filePath` only makes sense when the client and server share a
// filesystem (a same-host dev/test setup -- see server.js's own doc
// comment on it); every legitimate caller, including every test in this
// suite, already drops its file in the OS temp dir first. Without this
// restriction, filePath was an unrestricted arbitrary-file-read: any
// absolute path the client named (.env, a database backup, an SSH key)
// got read and, once past quota/auth, echoed straight back as each
// result's `address` field. BATCH_FILE_BASE_DIR lets a real deployment
// point at a different shared directory instead, if the temp dir isn't
// suitable there.
const ALLOWED_BATCH_DIR = fs.realpathSync(process.env.BATCH_FILE_BASE_DIR || os.tmpdir());

function isWithinAllowedDir(candidatePath) {
  return candidatePath === ALLOWED_BATCH_DIR || candidatePath.startsWith(ALLOWED_BATCH_DIR + path.sep);
}

/** Reads and validates a plain-text file (one address per line) into a list of addresses. */
function readAddressLines(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ValidationError('filePath must be a non-empty string');
  }
  const resolvedPath = path.resolve(filePath.trim());
  // Checked before the file is even looked up, on the resolved (not yet
  // existence-checked) path -- a path outside the allowed directory is
  // rejected the same way whether or not it happens to exist, so nothing
  // outside this sandbox has its existence revealed either.
  if (!isWithinAllowedDir(resolvedPath)) {
    throw new ValidationError(`filePath must be inside ${ALLOWED_BATCH_DIR}`);
  }

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    throw new NotFoundError(`file not found: ${resolvedPath}`);
  }
  if (!stat.isFile()) {
    throw new ValidationError(`not a file: ${resolvedPath}`);
  }
  // Re-checked against the symlink-resolved real path -- a symlink
  // planted inside the allowed directory could otherwise still point
  // somewhere else entirely.
  if (!isWithinAllowedDir(fs.realpathSync(resolvedPath))) {
    throw new ValidationError(`filePath must be inside ${ALLOWED_BATCH_DIR}`);
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
 * Geocodes each address independently, one at a time. A failure on one
 * line doesn't stop the batch; each result reports its own
 * success/failure. No cap on address count: callers accept that a large
 * enough batch will tie up the server for however long it takes to run,
 * since nothing here queues or rate-limits. Sequential (not
 * Promise.all'd) on purpose -- a batch of thousands of addresses firing
 * that many concurrent queries at once would exhaust the pg pool's
 * connections instead of just taking longer.
 */
async function geocodeAddressList(db, addresses, options = {}) {
  const results = [];
  for (const address of addresses) {
    try {
      const result = await geocode(db, address, options);
      results.push({ address, success: true, ...result });
    } catch (err) {
      results.push({ address, success: false, error: err.message });
    }
  }
  return results;
}

async function geocodeBatch(db, filePath, options = {}) {
  const addresses = readAddressLines(filePath);
  return geocodeAddressList(db, addresses, options);
}

module.exports = {
  geocodeBatch,
  geocodeAddressList,
  readAddressLines,
  readAddressContent,
};
