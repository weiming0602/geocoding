const { parseLinestring, metersPerDegree } = require('./interpolate');
const { ValidationError, NotFoundError } = require('./errors');

const INITIAL_RADIUS_METERS = 200;
const MAX_RADIUS_METERS = 20000;

function toLocalMeters(lon, lat, originLon, originLat, mPerDegLon, mPerDegLat) {
  return [(lon - originLon) * mPerDegLon, (lat - originLat) * mPerDegLat];
}

function fromLocalMeters(xM, yM, originLon, originLat, mPerDegLon, mPerDegLat) {
  return [originLon + xM / mPerDegLon, originLat + yM / mPerDegLat];
}

/** Closest point on segment AB to point P, all in the same local (meters) space. */
function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * abx;
  const y = ay + t * aby;
  return { t, x, y, distance: Math.hypot(px - x, py - y) };
}

/**
 * Finds the closest point on a (possibly multi-segment) line to
 * (queryLon, queryLat), working in meters local to the query point so
 * distances are real-world accurate. Returns the closest point's
 * lon/lat, distance in meters, its fraction (0-1) along the *whole*
 * line (for address-range interpolation), and which side of the
 * matched segment's direction of travel the query point falls on.
 */
function closestPointOnLine(points, queryLon, queryLat) {
  const [mPerDegLon, mPerDegLat] = metersPerDegree(queryLat);
  const local = points.map(([lon, lat]) =>
    toLocalMeters(lon, lat, queryLon, queryLat, mPerDegLon, mPerDegLat)
  );

  const segLens = [];
  for (let i = 0; i < local.length - 1; i++) {
    const [x1, y1] = local[i];
    const [x2, y2] = local[i + 1];
    segLens.push(Math.hypot(x2 - x1, y2 - y1));
  }
  const totalLen = segLens.reduce((a, b) => a + b, 0);

  let best = null;
  let cumBefore = 0;
  for (let i = 0; i < segLens.length; i++) {
    const [ax, ay] = local[i];
    const [bx, by] = local[i + 1];
    const res = closestPointOnSegment(0, 0, ax, ay, bx, by);
    if (!best || res.distance < best.distance) {
      best = {
        ...res,
        arcLength: cumBefore + res.t * segLens[i],
        segDx: bx - ax,
        segDy: by - ay,
      };
    }
    cumBefore += segLens[i];
  }

  const fraction = totalLen > 0 ? best.arcLength / totalLen : 0;
  const [matchedLon, matchedLat] = fromLocalMeters(
    best.x, best.y, queryLon, queryLat, mPerDegLon, mPerDegLat
  );

  // Query point is the local origin (0,0); v points from the matched
  // point back to it. cross(segmentDirection, v) > 0 => left, < 0 => right
  // (matches the left/right convention used by interpolateAlongLine).
  const vx = -best.x;
  const vy = -best.y;
  const cross = best.segDx * vy - best.segDy * vx;
  const side = cross >= 0 ? 'left' : 'right';

  return { distance: best.distance, fraction, matchedLon, matchedLat, side };
}

/** Rounds `raw` to the nearest integer whose parity matches `side` (left=odd, right=even). */
function roundToSideParity(raw, side) {
  const wantOdd = side === 'left';
  const rounded = Math.round(raw);
  if (rounded % 2 === (wantOdd ? 1 : 0)) {
    return rounded;
  }
  const up = rounded + 1;
  const down = rounded - 1;
  return Math.abs(up - raw) <= Math.abs(down - raw) ? up : down;
}

function validateCoordinate(latitude, longitude) {
  if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new ValidationError('latitude must be a number');
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new ValidationError('longitude must be a number');
  }
  if (latitude < -90 || latitude > 90) {
    throw new ValidationError('latitude must be between -90 and 90');
  }
  if (longitude < -180 || longitude > 180) {
    throw new ValidationError('longitude must be between -180 and 180');
  }
}

function findCandidates(db, latitude, longitude, radiusMeters) {
  const [mPerDegLon, mPerDegLat] = metersPerDegree(latitude);
  const dLon = radiusMeters / mPerDegLon;
  const dLat = radiusMeters / mPerDegLat;

  return db
    .prepare(
      `SELECT * FROM streets
       WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
         AND fullname != '' AND geometry IS NOT NULL`
    )
    .all(longitude + dLon, longitude - dLon, latitude + dLat, latitude - dLat);
}

/**
 * Resolves a coordinate to the nearest street address by finding the
 * closest street segment (expanding a bounding-box search outward until
 * something's found) and interpolating a house number from where along
 * that segment the point projects to, on whichever side it falls on.
 */
function reverseGeocode(db, latitude, longitude) {
  validateCoordinate(latitude, longitude);

  let candidates = [];
  let radius = INITIAL_RADIUS_METERS;
  while (radius <= MAX_RADIUS_METERS) {
    candidates = findCandidates(db, latitude, longitude, radius);
    if (candidates.length > 0) break;
    radius *= 2;
  }
  if (candidates.length === 0) {
    throw new NotFoundError(
      `no street found within ${MAX_RADIUS_METERS}m of (${latitude}, ${longitude})`
    );
  }

  let best = null;
  for (const row of candidates) {
    let points;
    try {
      points = parseLinestring(row.geometry);
    } catch {
      continue; // e.g. a MULTILINESTRING, which this reverse search doesn't handle
    }
    if (points.length < 2) continue;

    const result = closestPointOnLine(points, longitude, latitude);
    if (!best || result.distance < best.distance) {
      best = { row, ...result };
    }
  }
  if (!best) {
    throw new NotFoundError(
      `no usable street geometry found within ${MAX_RADIUS_METERS}m of (${latitude}, ${longitude})`
    );
  }

  const [fromCol, toCol] = best.side === 'left' ? ['lfromadd', 'ltoadd'] : ['rfromadd', 'rtoadd'];
  const fromRaw = best.row[fromCol];
  const toRaw = best.row[toCol];

  let number = null;
  if (fromRaw && toRaw) {
    const fromNum = parseInt(fromRaw, 10);
    const toNum = parseInt(toRaw, 10);
    if (!Number.isNaN(fromNum) && !Number.isNaN(toNum)) {
      const raw = fromNum + best.fraction * (toNum - fromNum);
      number = roundToSideParity(raw, best.side);
    }
  }

  return {
    input: { latitude, longitude },
    match: {
      id: best.row.id,
      tlid: best.row.tlid,
      fullname: best.row.fullname,
      zipl: best.row.zipl,
      zipr: best.row.zipr,
      state: best.row.state,
      state_abbr: best.row.state_abbr,
    },
    side: best.side,
    number,
    address: number !== null ? `${number} ${best.row.fullname}` : best.row.fullname,
    distanceMeters: best.distance,
    matchedCoordinates: { latitude: best.matchedLat, longitude: best.matchedLon },
  };
}

module.exports = { reverseGeocode, closestPointOnLine, closestPointOnSegment, roundToSideParity };
