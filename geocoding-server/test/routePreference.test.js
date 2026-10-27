const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rankRoutes,
  relevantWeightedPoints,
  groupCandidatePoints,
  chooseBestGroup,
  weightFactor,
  distanceToPolylineMeters,
} = require('../src/routePreference');

// Near the equator, where metersPerDegree is 111320 for both axes.
const M = 1 / 111320; // one meter in degrees

function route(distanceMeters, coordinates) {
  return { geometry: { type: 'LineString', coordinates }, distanceMeters };
}
const DIRECT = route(2000, [[0, 0], [2000 * M, 0]]);
// A detour 200 m north: ~2400 m long.
const NORTH = route(2400, [[0, 0], [0, 200 * M], [2000 * M, 200 * M], [2000 * M, 0]]);
const POINT_ON_NORTH = { latitude: 200 * M, longitude: 1000 * M, weight: 5 };
const START = { latitude: 0, longitude: 0 };
const END = { latitude: 0, longitude: 2000 * M };

test('weightFactor: heaviest point gets the biggest discount, a weightless one the smallest', () => {
  assert.equal(weightFactor(10, 10), 0.3);
  assert.equal(weightFactor(0, 10), 0.7);
  assert.ok(Math.abs(weightFactor(5, 10) - 0.5) < 1e-9);
  assert.equal(weightFactor(0, 0), 0.3);
});

test('distanceToPolylineMeters measures to the nearest segment, not just vertices', () => {
  assert.ok(Math.abs(distanceToPolylineMeters({ latitude: 30 * M, longitude: 1000 * M }, DIRECT.geometry.coordinates) - 30) < 0.5);
});

test('rankRoutes prefers a somewhat longer route that passes a weighted point, and flags it', () => {
  const [first, second] = rankRoutes([DIRECT, NORTH], [POINT_ON_NORTH], 3, START, END);
  assert.equal(first.distanceMeters, 2400);
  assert.equal(first.usesWeightedPoints, true);
  assert.equal(first.weightedPointsPassed, 1);
  assert.equal(second.distanceMeters, 2000);
  assert.equal(second.usesWeightedPoints, false);
});

test('rankRoutes still picks the shorter route when the weighted one is more than ~3x longer', () => {
  const huge = route(7000, NORTH.geometry.coordinates);
  const [first] = rankRoutes([DIRECT, huge], [POINT_ON_NORTH], 3, START, END);
  assert.equal(first.distanceMeters, 2000);
});

test('rankRoutes with no weighted points orders by distance and flags nothing', () => {
  const ranked = rankRoutes([NORTH, DIRECT], [], 3, START, END);
  assert.deepEqual(ranked.map((r) => r.distanceMeters), [2000, 2400]);
  assert.ok(ranked.every((r) => r.usesWeightedPoints === false));
});

test('rankRoutes drops duplicate geometry and honors the limit', () => {
  const ranked = rankRoutes([DIRECT, { ...DIRECT }, NORTH], [], 1, START, END);
  assert.equal(ranked.length, 1);
  assert.equal(rankRoutes([DIRECT, { ...DIRECT }, NORTH], [], 5, START, END).length, 2);
});

test('relevantWeightedPoints keeps points roughly on the way, heaviest first, not at the ends', () => {
  const start = { latitude: 0, longitude: 0 };
  const end = { latitude: 0, longitude: 2000 * M };
  const onTheWay = { latitude: 200 * M, longitude: 1000 * M, weight: 2 };
  const heavier = { latitude: -300 * M, longitude: 900 * M, weight: 9 };
  const farOff = { latitude: 5000 * M, longitude: 1000 * M, weight: 50 }; // via it is ~5x the direct distance
  const atStart = { latitude: 20 * M, longitude: 0, weight: 99 }; // at the start itself (within 50 m)
  assert.deepEqual(relevantWeightedPoints([onTheWay, farOff, atStart, heavier], start, end), [heavier, onTheWay]);
});

// Reported in the sandbox: a weighted point ~350 m before the target must
// still pull the route along that street (an earlier 500 m "near the end"
// exclusion dropped it). Only points essentially AT an end are ignored.
test('rankRoutes counts a weighted point a few hundred meters from the destination', () => {
  const nearDestination = { latitude: 200 * M, longitude: 1650 * M, weight: 5 }; // ~400 m from END, on NORTH
  const [first] = rankRoutes([DIRECT, NORTH], [nearDestination], 3, START, END);
  assert.equal(first.distanceMeters, 2400);
  assert.equal(first.usesWeightedPoints, true);
});

test('rankRoutes puts the route meeting the most weighted points first, even past a heavier single point', () => {
  const southDetour = route(2400, [[0, 0], [0, -200 * M], [2000 * M, -200 * M], [2000 * M, 0]]);
  const heavySouth = { latitude: -200 * M, longitude: 1000 * M, weight: 20 };
  const north1 = { latitude: 200 * M, longitude: 600 * M, weight: 2 };
  const north2 = { latitude: 200 * M, longitude: 1400 * M, weight: 2 };
  const [first] = rankRoutes([DIRECT, southDetour, NORTH], [heavySouth, north1, north2], 3, START, END);
  assert.equal(first.weightedPointsPassed, 2);
  assert.ok(first.geometry.coordinates.some(([, lat]) => lat > 0));
});

test('rankRoutes never lets a route over 3x the shortest win, however many points it passes', () => {
  const longWay = route(6500, NORTH.geometry.coordinates);
  const [first] = rankRoutes([DIRECT, longWay], [POINT_ON_NORTH], 3, START, END);
  assert.equal(first.distanceMeters, 2000);
});

// chooseBestGroup works from real driving distances. Modelled on the
// Brunswick -> Freeport trip: A is a one-way interstate carriageway
// (only enterable at its north end, a1 -> a2), B a two-way street just
// east of the destination. In straight-line terms B comes first, but by
// road, doing B first means driving back north to reach A's entry.
test('chooseBestGroup orders points by driving distance, honoring one-way direction', () => {
  const legs = {
    'S>a1': 18000, 'S>b1': 19000, 'S>b2': 19200, 'S>E': 21000,
    'a2>b1': 1500, 'a2>b2': 1700, 'a2>E': 1600,
    'b1>a1': 9000, 'b2>a1': 9200, 'b1>E': 600, 'b2>E': 400,
  };
  const cost = (x, y) => (x === y ? 0 : (legs[`${x}>${y}`] ?? Infinity));
  const A = { name: 'A' };
  const B = { name: 'B' };
  const best = chooseBestGroup({
    startNode: 'S',
    endNode: 'E',
    cost,
    segments: [
      { point: A, factor: 0.5, length: 1000, orientations: [['a1', 'a2']] },
      { point: B, factor: 0.5, length: 200, orientations: [['b1', 'b2'], ['b2', 'b1']] },
    ],
  });
  assert.deepEqual(best.points, [A, B]);
  assert.deepEqual(best.nodes, ['a1', 'a2', 'b1', 'b2']);
  assert.equal(best.length, 18000 + 1000 + 1500 + 200 + 400);
});

test('chooseBestGroup drops points that would push the route past 3x the direct distance', () => {
  const legs = { 'S>E': 1000, 'S>p1': 500, 'p2>E': 500, 'S>q1': 4000, 'q2>E': 4000, 'p2>q1': 4000, 'q2>p1': 4000 };
  const cost = (x, y) => (x === y ? 0 : (legs[`${x}>${y}`] ?? Infinity));
  const near = { name: 'near' };
  const far = { name: 'far' };
  const best = chooseBestGroup({
    startNode: 'S',
    endNode: 'E',
    cost,
    segments: [
      { point: near, factor: 0.5, length: 100, orientations: [['p1', 'p2']] },
      { point: far, factor: 0.3, length: 100, orientations: [['q1', 'q2']] },
    ],
  });
  assert.deepEqual(best.points, [near]); // with `far` it's > 3000 m
});

test('groupCandidatePoints keeps relevant points, heaviest first, at most 6', () => {
  const start = { latitude: 0, longitude: 0 };
  const end = { latitude: 0, longitude: 2000 * M };
  const many = Array.from({ length: 8 }, (_, i) => ({ latitude: 100 * M, longitude: (200 + i * 200) * M, weight: i }));
  const chosen = groupCandidatePoints(many, start, end);
  assert.equal(chosen.length, 6);
  assert.deepEqual(chosen.map((p) => p.weight), [7, 6, 5, 4, 3, 2]);
});

test('viaRouteRows joins legs into one route, and returns [] when a leg is unreachable', async () => {
  const { createTestDatabase } = require('./helpers');
  const { seedRoadRerouteFixture } = require('./roadRerouteFixture');
  const { viaRouteRows } = require('../src/routePreference');
  const { pool, drop } = await createTestDatabase({ postgis: true, pgrouting: true });
  try {
    await seedRoadRerouteFixture(pool);
    const { rows: nodes } = await pool.query('SELECT id FROM streets_topology_nodes ORDER BY ST_X(geom), ST_Y(geom)');
    const { rows: edges } = await pool.query('SELECT source, target, cost FROM streets_routing_edges');
    // Any two edges sharing a node: a two-leg trip whose length is their sum.
    const [first] = edges;
    const second = edges.find((e) => e !== first && (e.source === first.target || e.target === first.target) && e.source !== first.source);
    const end = second.source === first.target ? second.target : second.source;
    const allEdges = 'SELECT id, source, target, cost, cost AS reverse_cost FROM streets_routing_edges';
    const rows = await viaRouteRows(pool, allEdges, [first.source, first.target, end], true);
    assert.ok(Math.abs(rows.at(-1).route_agg_cost - (first.cost + second.cost)) < 1e-6);
    assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i + 1));
    // Without any edges touching `end`, the second leg can't be driven.
    const cutOff = `${allEdges} WHERE source <> ${end} AND target <> ${end}`;
    assert.deepEqual(await viaRouteRows(pool, cutOff, [first.source, first.target, end], true), []);
    assert.ok(nodes.length > 0);
  } finally {
    await drop();
  }
});
