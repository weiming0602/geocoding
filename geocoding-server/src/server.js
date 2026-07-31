const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const { geocode } = require('./geocode');
const { geocodeBatch, geocodeAddressList, readAddressLines } = require('./batchGeocode');
const { resultsToCsv } = require('./resultsCsv');
const { buildZip } = require('./zip');
const { reverseGeocode } = require('./reverseGeocode');
const { openUsersDb } = require('./users');
const { checkQuota, useQuota } = require('./quota');
const { sendResultsEmail } = require('./emailDelivery');
const {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
} = require('./errors');

const DB_PATH = process.env.GEOCODING_DB_PATH || 'C:\\software\\database\\sqlite3\\geocoding.sqlite';
const USERS_DB_PATH = process.env.USERS_DB_PATH || 'C:\\software\\database\\sqlite3\\users.sqlite';
const PORT = Number(process.env.PORT) || 3001;
const OFFSET_FEET = Number(process.env.OFFSET_FEET) || 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const usersDb = openUsersDb(USERS_DB_PATH);

const app = express();
app.use(cors());
app.use(express.json());

app.post('/geocode', (req, res) => {
  const address = req.body && req.body.address;
  try {
    const result = geocode(db, address, { offsetFeet: OFFSET_FEET });
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/geocode/batch', (req, res) => {
  const filePath = req.body && req.body.filePath;
  try {
    const results = geocodeBatch(db, filePath, { offsetFeet: OFFSET_FEET });
    res.json({ results });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/geocode/batch/download', (req, res) => {
  const filePath = req.body && req.body.filePath;

  let results;
  try {
    results = geocodeBatch(db, filePath, { offsetFeet: OFFSET_FEET });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }

  const { successCsv, errorCsv } = resultsToCsv(results);
  const zipBuffer = buildZip([
    { name: 'results.csv', content: successCsv },
    { name: 'errors.csv', content: errorCsv },
  ]);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="batch-geocode-results.zip"');
  res.send(zipBuffer);
});

app.post('/geocode/batch/email', async (req, res) => {
  const filePath = req.body && req.body.filePath;
  const email = req.body && req.body.email;

  try {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }

    const addresses = readAddressLines(filePath);
    const user = checkQuota(usersDb, email, addresses.length);

    const results = geocodeAddressList(db, addresses, { offsetFeet: OFFSET_FEET });
    const { successCsv, errorCsv } = resultsToCsv(results);
    const zipBuffer = buildZip([
      { name: 'results.csv', content: successCsv },
      { name: 'errors.csv', content: errorCsv },
    ]);

    useQuota(usersDb, email, addresses.length);
    const delivery = await sendResultsEmail(email, zipBuffer, { addressCount: addresses.length });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="batch-geocode-results.zip"');
    res.setHeader(
      'X-Quota',
      `${user.used_this_period + addresses.length}/${user.tier}`
    );
    res.setHeader('X-Email-Delivery', delivery.stubbed ? 'stubbed' : 'sent');
    res.send(zipBuffer);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/reverse-geocode', (req, res) => {
  const { latitude, longitude } = req.body || {};
  try {
    const result = reverseGeocode(db, latitude, longitude);
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`geocoding-server listening on http://localhost:${PORT}`);
    console.log(`using database: ${DB_PATH}`);
  });
}

module.exports = { app, db, usersDb };
