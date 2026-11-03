#!/usr/bin/env node
// Geocodes addresses for the accuracy benchmark (benchmarks/geocoding/,
// driven by its Python runner) with Meridian's own geocode(), straight
// against the database -- no HTTP server, quota, or rate limit involved.
//
//   node scripts/benchmark-geocode.js [--tiger-only] < addresses.jsonl > results.jsonl
//
// stdin:  one JSON object per line: {"id": "...", "address": "..."}
// stdout: one per line: {"id", "matched", "latitude", "longitude", "source", "error"}
//
// --tiger-only skips E911 address points (geocode()'s useAddressPoints),
// i.e. what Meridian returns wherever there's no E911 data.

require('dotenv').config({ quiet: true });

const readline = require('readline');
const { createReadOnlyPool } = require('../src/db');
const { geocode } = require('../src/geocode');

const GEOCODING_DSN = process.env.GEOCODING_DSN || 'postgresql://my_ai@%2Fvar%2Frun%2Fpostgresql/geocoding';

async function main() {
  const useAddressPoints = !process.argv.includes('--tiger-only');
  const db = createReadOnlyPool(GEOCODING_DSN);
  const lines = readline.createInterface({ input: process.stdin });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const { id, address } = JSON.parse(line);
      let out;
      try {
        const result = await geocode(db, address, { useAddressPoints });
        out = {
          id,
          matched: true,
          latitude: result.coordinates.latitude,
          longitude: result.coordinates.longitude,
          source: result.source,
          error: null,
        };
      } catch (err) {
        out = { id, matched: false, latitude: null, longitude: null, source: null, error: err.message };
      }
      process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
