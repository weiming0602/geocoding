const test = require('node:test');
const assert = require('node:assert/strict');

const { matchByStreetAndZip } = require('../src/geocodeMatching');
const { OutOfRangeError } = require('../src/errors');
const { makeDb } = require('./helpers');

// Modelled on Exeter NH's High St in the 2025 TIGER data: odd numbers run
// 29-31 on one segment and 37-53 on the next, so 33 and 35 fall in a hole
// no segment's range covers. Further along there's a wide numbering jump
// (53 -> 151) and a far-away stretch (301-311 vs 315-325, 5 km apart).
// Lines run north along longitude -70.3 (~11.1 m per 0.0001 degree of
// latitude); odd numbers on the left, even on the right.
const SEGMENTS = [
  { id: 9001, l: [29, 31], r: [28, 30], from: 43.9, to: 43.9005 },
  { id: 9002, l: [37, 53], r: [36, 52], from: 43.9006, to: 43.902 },
  { id: 9003, l: [151, 171], r: [150, 170], from: 43.9021, to: 43.903 },
  { id: 9004, l: [301, 311], r: [300, 310], from: 43.95, to: 43.951 },
  { id: 9005, l: [315, 325], r: [314, 324], from: 43.996, to: 43.997 },
];

async function makeGapDb() {
  const db = await makeDb();
  for (const s of SEGMENTS) {
    const wkt = `LINESTRING (-70.3 ${s.from}, -70.3 ${s.to})`;
    await db.query(
      `INSERT INTO streets (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr,
                            geometry, minx, miny, maxx, maxy)
       VALUES ($1, $2, 'Gap St', $3, $4, $5, $6, '03833', '03833', 'New Hampshire', 'NH', $7, -70.3, $8, -70.3, $9)`,
      [s.id, `T${s.id}`, String(s.l[0]), String(s.l[1]), String(s.r[0]), String(s.r[1]), wkt, s.from, s.to]
    );
    await db.query(
      `INSERT INTO street_names (tlid, fullname, paflag, zipl, zipr, state, state_abbr)
       VALUES ($1, 'Gap St', 'P', '03833', '03833', 'New Hampshire', 'NH')`,
      [`T${s.id}`]
    );
  }
  return db;
}

test('a house number in a small numbering gap is placed between the two neighbouring ranges, marked approximate', async () => {
  const db = await makeGapDb();
  try {
    const result = await matchByStreetAndZip(db, 35, 'Gap St', '03833', 'NH', 20);
    assert.equal(result.approximate, true);
    assert.equal(result.source, 'interpolation');
    assert.equal(result.rangeSide, 'left'); // the odd side
    assert.equal(result.match.id, 9002); // 35 is nearer 37 than 31
    // Between the end of 29-31 (43.9005) and the start of 37-53 (43.9006),
    // two thirds of the way along (35 is 4 of the 6 numbers from 31 to 37).
    assert.ok(Math.abs(result.coordinates.latitude - 43.9005667) < 0.000005, result.coordinates.latitude);
    assert.ok(result.coordinates.longitude < -70.3, 'offset to the west, the left side going north');

    // A number a range does cover is unchanged: exact, not approximate.
    const exact = await matchByStreetAndZip(db, 41, 'Gap St', '03833', 'NH', 20);
    assert.equal(exact.approximate, undefined);
    assert.equal(exact.match.id, 9002);
  } finally {
    await db.close();
  }
});

test('the gap fallback never stretches past the street, across a wide numbering jump, or between far-apart pieces', async () => {
  const db = await makeGapDb();
  try {
    for (const [number, why] of [
      [27, 'below the first range'],
      [401, 'past the last range'],
      [99, 'a 98-number jump between 53 and 151'],
      [313, '311 and 315 are 5 km apart'],
    ]) {
      await assert.rejects(matchByStreetAndZip(db, number, 'Gap St', '03833', 'NH', 20), OutOfRangeError, `${number}: ${why}`);
    }
    // Even numbers use the even side's own ranges: 32 and 34 are in the
    // even gap 30 -> 36, so they're placed too, on the right.
    const even = await matchByStreetAndZip(db, 34, 'Gap St', '03833', 'NH', 20);
    assert.equal(even.approximate, true);
    assert.equal(even.rangeSide, 'right');
  } finally {
    await db.close();
  }
});
