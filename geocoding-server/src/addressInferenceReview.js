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

async function listReviewTowns(db) {
  const { rows } = await db.query(
    `SELECT region_id, town, max(run_date)::text AS run_date, count(*)::int AS addresses
     FROM address_inference.ml_predictions GROUP BY region_id, town ORDER BY town`
  );
  return rows.map((r) => ({ region: r.region_id, town: r.town, runDate: r.run_date, addresses: r.addresses }));
}

async function getAddressInferenceReview(db, town) {
  try {
    const towns = await listReviewTowns(db);
    if (towns.length === 0) throw new NotFoundError('no saved ML predictions yet');
    const selected = towns.find((t) => t.town.toLowerCase() === String(town || '').toLowerCase()) ?? towns[0];

    const { rows } = await db.query(
      `SELECT address_id, address_number, street, e911_lat, e911_lon, m0_lat, m0_lon,
              true_building, picked_building, picked_lat, picked_lon, error_m, status, candidates
       FROM address_inference.ml_predictions
       WHERE region_id = $1 AND town = $2
       ORDER BY street, address_number`,
      [selected.region, selected.town]
    );

    // Every footprint around the town's addresses: grey context, so the
    // building that should have been picked is visible next to the one
    // that was. 6 decimals is ~0.1 m -- plenty for a footprint outline.
    const { rows: buildings } = await db.query(
      `WITH bbox AS (
         SELECT ST_Expand(ST_Extent(ST_MakePoint(e911_lon, e911_lat))::geometry, 0.002) AS g
         FROM address_inference.ml_predictions WHERE region_id = $1 AND town = $2
       )
       SELECT s.source_id, s.sqmeters, ST_AsGeoJSON(s.geom, 6) AS geojson
       FROM address_inference.structures s, bbox
       WHERE s.geom && ST_SetSRID(bbox.g, 4326)`,
      [selected.region, selected.town]
    );

    const summary = {};
    for (const r of rows) summary[r.status] = (summary[r.status] ?? 0) + 1;

    return {
      towns,
      town: selected.town,
      region: selected.region,
      runDate: selected.runDate,
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
