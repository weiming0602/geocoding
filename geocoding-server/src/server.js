const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const { geocode } = require('./geocode');
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`geocoding-server listening on http://localhost:${PORT}`);
    console.log(`using database: ${DB_PATH}`);
  });
}

module.exports = { app, db };
