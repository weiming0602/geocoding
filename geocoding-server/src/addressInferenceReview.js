// Owner-only review of the building-address ML experiment
// (address_inference/, see docs/superpowers/specs/2026-11-02-building-
// address-inference-design.md): every training address in one town, with
// its E911 point, the building E911 says it is, and the building the
// cross-validated ranker picked -- so wrong matches can be looked at on a
// map. Rows come from address_inference.ml_predictions, written by
// `python -m address_inference.evaluate ... --save`; that schema exists
// only where the experiment was run, so a missing table is a NotFoundError,
// not a 500. Read-only, like everything else against the geocoding pool.

const { NotFoundError } = require('./errors');

const UNDEFINED_TABLE = '42P01';
// Saved by evaluate --save: the ranker alone, and the ranker + road order
// (address_inference/order.py). The *_ranges pair is an upper-bound
// experiment: the same pipeline with each segment's TIGER number range
// replaced by the min..max of the real E911 numbers along it (what a
// correctly-numbered road file would give) -- copied in by hand, not
// something evaluate produces. Any other value falls back to the default.
// *_list / *_auto: evaluate --ranges list|auto (the address list's own
// min..max per street side instead of TIGER's range; auto only where
// TIGER's range looks like a placeholder for sequential numbers).
const METHODS = [
  'ml_order', 'ml',
  'ml_order_auto', 'ml_auto',
  'ml_order_list', 'ml_list',
  'ml_order_ranges', 'ml_ranges',
];
// What "changed by road order" compares each method against.
const BASE_METHOD = Object.fromEntries(METHODS.map((m) => [m, m.replace('ml_order', 'ml')]));
BASE_METHOD.ml_order = 'ml';

async function listReviewTowns(db) {
  const { rows } = await db.query(
    `SELECT region_id, town, max(run_date)::text AS run_date, count(DISTINCT address_id)::int AS addresses,
            array_agg(DISTINCT method) AS methods
     FROM address_inference.ml_predictions GROUP BY region_id, town ORDER BY town`
  );
  return rows.map((r) => ({
    region: r.region_id,
    town: r.town,
    runDate: r.run_date,
    addresses: r.addresses,
    methods: r.methods,
  }));
}

async function getAddressInferenceReview(db, town, method) {
  const selectedMethod = METHODS.includes(method) ? method : METHODS[0];
  try {
    const towns = await listReviewTowns(db);
    if (towns.length === 0) throw new NotFoundError('no saved ML predictions yet');
    const selected = towns.find((t) => t.town.toLowerCase() === String(town || '').toLowerCase()) ?? towns[0];

    // ml_status/ml_pick: what the ranker alone did, so the page can show
    // where road order changed the pick.
    const { rows } = await db.query(
      `SELECT p.address_id, p.address_number, p.street, p.e911_lat, p.e911_lon, p.m0_lat, p.m0_lon,
              p.true_building, p.picked_building, p.picked_lat, p.picked_lon, p.error_m, p.status, p.candidates,
              base.status AS ml_status, base.picked_building AS ml_pick
       FROM address_inference.ml_predictions p
       LEFT JOIN address_inference.ml_predictions base
         ON base.region_id = p.region_id AND base.town = p.town AND base.method = $4
        AND base.address_id = p.address_id
       WHERE p.region_id = $1 AND p.town = $2 AND p.method = $3
       ORDER BY p.street, p.address_number`,
      [selected.region, selected.town, selectedMethod, BASE_METHOD[selectedMethod]]
    );

    // Every footprint around the town's addresses: grey context, so the
    // building that should have been picked is visible next to the one
    // that was. 6 decimals is ~0.1 m -- plenty for a footprint outline.
    const { rows: buildings } = await db.query(
      `WITH bbox AS (
         SELECT ST_Expand(ST_Extent(ST_MakePoint(e911_lon, e911_lat))::geometry, 0.002) AS g
         FROM address_inference.ml_predictions WHERE region_id = $1 AND town = $2 AND method = $3
       )
       SELECT s.source_id, s.sqmeters, ST_AsGeoJSON(s.geom, 6) AS geojson
       FROM address_inference.structures s, bbox
       WHERE s.geom && ST_SetSRID(bbox.g, 4326)`,
      [selected.region, selected.town, selectedMethod]
    );

    const summary = {};
    for (const r of rows) summary[r.status] = (summary[r.status] ?? 0) + 1;

    return {
      towns: towns.map(({ methods, ...t }) => t),
      town: selected.town,
      region: selected.region,
      runDate: selected.runDate,
      method: selectedMethod,
      // Only the methods this town actually has rows for.
      methods: METHODS.filter((m) => selected.methods.includes(m)),
      summary,
      addresses: rows.map((r) => ({
        id: r.address_id,
        number: r.address_number,
        street: r.street,
        e911: { latitude: r.e911_lat, longitude: r.e911_lon },
        interpolated: { latitude: r.m0_lat, longitude: r.m0_lon },
        trueBuilding: r.true_building,
        pickedBuilding: r.picked_building,
        picked: r.picked_lat == null ? null : { latitude: r.picked_lat, longitude: r.picked_lon },
        errorMeters: Math.round(r.error_m),
        status: r.status,
        candidates: r.candidates,
        mlStatus: r.ml_status ?? r.status,
        changedFromMl: r.ml_pick !== null && r.ml_pick !== undefined && r.ml_pick !== r.picked_building,
      })),
      buildings: {
        type: 'FeatureCollection',
        features: buildings.map((b) => ({
          type: 'Feature',
          geometry: JSON.parse(b.geojson),
          properties: { id: b.source_id, sqmeters: b.sqmeters == null ? null : Math.round(b.sqmeters) },
        })),
      },
    };
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) {
      throw new NotFoundError(
        'no building-address training data on this server -- run python -m address_inference.evaluate ... --save'
      );
    }
    throw err;
  }
}

module.exports = { getAddressInferenceReview };
