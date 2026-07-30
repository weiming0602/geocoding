const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const { geocode } = require('./geocode');
const { geocodeBatch } = require('./batchGeocode');
const { resultsToCsv } = require('./resultsCsv');
const { buildZip } = require('./zip');
const { ValidationError, NotFoundError, OutOfRangeError } = require('./errors');

const DB_PATH = process.env.GEOCODING_DB_PATH || 'C:\\software\\database\\sqlite3\\geocoding.sqlite';
const PORT = Number(process.env.PORT) || 3001;
const OFFSET_FEET = Number(process.env.OFFSET_FEET) || 20;

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`geocoding-server listening on http://localhost:${PORT}`);
    console.log(`using database: ${DB_PATH}`);
  });
}

module.exports = { app, db };
