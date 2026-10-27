const test = require('node:test');
const assert = require('node:assert/strict');

const { viaNodesForPoint } = require('../src/routePreference');
const { createTestDatabase } = require('./helpers');
const { seedRoadRerouteFixture, setOneway, NODES } = require('./roadRerouteFixture');

// viaNodesForPoint picks the order a weighted point's street segment is
// driven in. E4 is the fixture's north row, drawn N4 -> N5 (west -> east);
// the weighted point sits mid-row, and the trip starts at N1 -- nearer N4.
const POINT = { latitude: NODES.N4.latitude, longitude: NODES.N5.longitude / 2, weight: 5 };

async function nodeId(pool, name) {
  const { rows } = await pool.query('SELECT id FROM streets_topology_nodes WHERE tnid = $1', [name]);
  return rows[0].id;
}

async function viaOrderWith(oneways) {
  const { pool, drop } = await createTestDatabase({ postgis: true, pgrouting: true });
  try {
    await seedRoadRerouteFixture(pool);
    await setOneway(pool, oneways);
    const order = await viaNodesForPoint(pool, POINT, NODES.N1);
    return { order, n4: await nodeId(pool, 'N4'), n5: await nodeId(pool, 'N5') };
  } finally {
    await drop();
  }
}

test('viaNodesForPoint enters a two-way segment from the end nearer the previous stop', async () => {
  const { order, n4, n5 } = await viaOrderWith({});
  assert.deepEqual(order, [n4, n5]);
});

test("viaNodesForPoint enters a one-way segment at its legal start, even when the other end is nearer", async () => {
  const { order, n4, n5 } = await viaOrderWith({ E4: -1 }); // only N5 -> N4
  assert.deepEqual(order, [n5, n4]);
});

test('viaNodesForPoint keeps a one-way segment\'s drawn order when that is the legal one', async () => {
  const { order, n4, n5 } = await viaOrderWith({ E4: 1 }); // only N4 -> N5
  assert.deepEqual(order, [n4, n5]);
});
