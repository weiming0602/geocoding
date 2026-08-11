const METERS_PER_FOOT = 0.3048;

/** Parses a WKT LINESTRING into a list of [lon, lat] points. */
function parseLinestring(wkt) {
  const match = /^\s*LINESTRING\s*\((.*)\)\s*$/.exec(wkt);
  if (!match) {
    throw new Error(`expected a WKT LINESTRING, got: ${wkt}`);
  }
  return match[1].split(',').map((pair) => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return [x, y];
  });
}

function metersPerDegree(lat) {
  const latRad = (lat * Math.PI) / 180;
  return [111320.0 * Math.cos(latRad), 111320.0];
}

/**
 * Finds the point at `fraction` of the way along a line, with an
 * optional perpendicular offset (in feet) to the left or right of the
 * direction of travel.
 */
function interpolateAlongLine(points, fraction, offsetFeet = 0, offsetSide = 'right') {
  if (offsetSide !== 'left' && offsetSide !== 'right') {
    throw new Error("offsetSide must be 'left' or 'right'");
  }

  const segLens = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    segLens.push(Math.hypot(x2 - x1, y2 - y1));
  }
  const totalLen = segLens.reduce((a, b) => a + b, 0);
  const target = fraction * totalLen;

  let x, y, segDx, segDy;
  let distSoFar = 0;
  let found = false;
  for (let i = 0; i < segLens.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const segLen = segLens[i];
    // segLen === 0 was previously included here too, meant to handle a
    // degenerate segment sitting exactly at the target distance -- but
    // that case is already covered by ">=" alone (distSoFar + 0 >= target
    // only once distSoFar has actually reached target). Including it
    // unconditionally instead made the walk snap to *any* duplicate
    // vertex it passed through, long before reaching the real target.
    if (distSoFar + segLen >= target) {
      const t = segLen ? (target - distSoFar) / segLen : 0;
      x = x1 + t * (x2 - x1);
      y = y1 + t * (y2 - y1);
      segDx = x2 - x1;
      segDy = y2 - y1;
      found = true;
      break;
    }
    distSoFar += segLen;
  }
  if (!found) {
    const [x1, y1] = points[points.length - 2];
    const [x2, y2] = points[points.length - 1];
    x = x2;
    y = y2;
    segDx = x2 - x1;
    segDy = y2 - y1;
  }

  if (offsetFeet === 0) {
    return [x, y];
  }

  const [mPerDegLon, mPerDegLat] = metersPerDegree(y);
  const dxM = segDx * mPerDegLon;
  const dyM = segDy * mPerDegLat;
  const segLenM = Math.hypot(dxM, dyM);

  const unitM =
    offsetSide === 'right'
      ? [dyM / segLenM, -dxM / segLenM]
      : [-dyM / segLenM, dxM / segLenM];

  const offsetM = offsetFeet * METERS_PER_FOOT;
  const offsetXDeg = (unitM[0] * offsetM) / mPerDegLon;
  const offsetYDeg = (unitM[1] * offsetM) / mPerDegLat;

  return [x + offsetXDeg, y + offsetYDeg];
}

module.exports = { parseLinestring, interpolateAlongLine, metersPerDegree };
