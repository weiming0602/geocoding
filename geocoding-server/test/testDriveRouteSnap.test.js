const test = require('node:test');
const assert = require('node:assert/strict');

const { nearestLocalStreetNodeId } = require('../src/testDriveRoute');
const { nearestTopologyNodeId } = require('../src/roadReroute');
const { createTestDatabase } = require('./helpers');
const { seedRoadRerouteFixture, NODES } = require('./roadRerouteFixture');

// A simulated drive's start/end snaps to an ordinary street's
// intersection, not an interstate's: the fixture's north row (E3 N1->N4,
// E4 N4->N5) is marked limited-access (S1100), so N4 touches only highway.
// A start 10 m from N4 must snap to N1 (200 m away, also on ordinary
// streets) instead -- while real-driver snapping still takes N4.
test('nearestLocalStreetNodeId skips an intersection that only touches a highway', async () => {
  const { pool, drop } = await createTestDatabase({ postgis: true, pgrouting: true });
  try {
    await seedRoadRerouteFixture(pool);
    await pool.query(`UPDATE streets SET mtfcc = 'S1100' WHERE tlid IN ('E3', 'E4')`);
    const start = { latitude: NODES.N4.latitude, longitude: NODES.N4.longitude + 10 / 111320 };
    const idOf = async (tnid) => (await pool.query('SELECT id FROM streets_topology_nodes WHERE tnid = $1', [tnid])).rows[0].id;

    assert.equal(await nearestTopologyNodeId(pool, start.latitude, start.longitude), await idOf('N4'));
    assert.equal(await nearestLocalStreetNodeId(pool, start.latitude, start.longitude), await idOf('N1'));
  } finally {
    await drop();
  }
});

test('nearestLocalStreetNodeId falls back to the nearest intersection when no ordinary street is close', async () => {
  const { pool, drop } = await createTestDatabase({ postgis: true, pgrouting: true });
  try {
    await seedRoadRerouteFixture(pool);
    await pool.query(`UPDATE streets SET mtfcc = 'S1100'`);
    const id = await nearestLocalStreetNodeId(pool, NODES.N2.latitude, NODES.N2.longitude);
    assert.equal(id, await nearestTopologyNodeId(pool, NODES.N2.latitude, NODES.N2.longitude));
  } finally {
    await drop();
  }
});
