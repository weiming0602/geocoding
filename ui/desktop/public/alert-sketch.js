// Draws the small "where is this hazard" picture attached to Road Alerts
// notifications (the Notification API's `image` option): the driver's
// recent trail, an arrow for their position and heading, and the hazard
// as a red dot, with a distance label. A plain sketch on a plain
// background, north up -- not a map: notification images are small
// (Windows shows ~360x180) and map tiles would be illegible at that size.
//
// Plain JavaScript, not TypeScript under src/, because the service worker
// (public/sw.js, served verbatim -- no build step) loads it with
// importScripts(). Both notification paths go through the service worker
// (see roadAlertNotifications.ts's showAlertNotification), so this is the
// only drawing code. Exposes self.RoadAlertSketch.
//
// Shown on Chrome/Edge for Windows, Android and ChromeOS; macOS, iOS and
// Firefox ignore notification images, so a notification there simply
// stays text-only.
(function (root) {
  'use strict';

  var EARTH_RADIUS_M = 6371000;
  var WIDTH = 360;
  var HEIGHT = 180;
  var PADDING = 22;
  // Room kept clear at the bottom for the distance label.
  var LABEL_BAND = 28;
  // Never zoom in tighter than this many meters across, so a hazard 40 m
  // away doesn't fill the whole picture.
  var MIN_SPAN_M = 300;

  function isCoordinate(point) {
    return (
      !!point &&
      typeof point.latitude === 'number' &&
      typeof point.longitude === 'number' &&
      isFinite(point.latitude) &&
      isFinite(point.longitude)
    );
  }

  function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  /** Flat east/north offset of `point` from `origin`, in meters -- fine at sketch scale. */
  function toLocalMeters(origin, point) {
    return {
      x: toRadians(point.longitude - origin.longitude) * EARTH_RADIUS_M * Math.cos(toRadians(origin.latitude)),
      y: toRadians(point.latitude - origin.latitude) * EARTH_RADIUS_M,
    };
  }

  function haversineMeters(a, b) {
    var dLat = toRadians(b.latitude - a.latitude);
    var dLon = toRadians(b.longitude - a.longitude);
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
  }

  /** "80 m away", "850 m away", "1.4 km away" -- same metric units as the Road Alerts page. */
  function formatDistance(meters) {
    if (meters < 1000) return Math.round(meters / 10) * 10 + ' m away';
    return (meters / 1000).toFixed(1) + ' km away';
  }

  /**
   * Lays out the sketch in pixels. input: { position, hazard, headingDeg
   * (degrees clockwise from north, or null/undefined if unknown), trail
   * (oldest first, optional) }, each point { latitude, longitude }.
   * Returns null if position or hazard isn't a real coordinate.
   */
  function buildSketch(input) {
    if (!input || !isCoordinate(input.position) || !isCoordinate(input.hazard)) return null;
    var origin = input.position;
    var trail = (input.trail || []).filter(isCoordinate).map(function (p) {
      return toLocalMeters(origin, p);
    });
    var car = { x: 0, y: 0 };
    var hazard = toLocalMeters(origin, input.hazard);
    var all = trail.concat([car, hazard]);

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    all.forEach(function (p) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    });
    var midX = (minX + maxX) / 2;
    var midY = (minY + maxY) / 2;
    var spanX = Math.max(maxX - minX, MIN_SPAN_M);
    var spanY = Math.max(maxY - minY, MIN_SPAN_M);

    var drawWidth = WIDTH - 2 * PADDING;
    var drawHeight = HEIGHT - 2 * PADDING - LABEL_BAND;
    // One scale for both axes, so the shape isn't distorted.
    var scale = Math.min(drawWidth / spanX, drawHeight / spanY);
    var centerX = WIDTH / 2;
    var centerY = PADDING + drawHeight / 2;
    function toPixels(p) {
      // North up: larger y (north) is higher on the canvas, i.e. smaller pixel y.
      return { x: centerX + (p.x - midX) * scale, y: centerY - (p.y - midY) * scale };
    }

    var heading = input.headingDeg;
    var carPixels = toPixels(car);
    return {
      width: WIDTH,
      height: HEIGHT,
      trail: trail.length > 0 ? trail.map(toPixels).concat([carPixels]) : [],
      car: {
        x: carPixels.x,
        y: carPixels.y,
        headingDeg: typeof heading === 'number' && isFinite(heading) && heading >= 0 ? heading % 360 : null,
      },
      hazard: toPixels(hazard),
      label: formatDistance(haversineMeters(input.position, input.hazard)),
    };
  }

  /** Draws a buildSketch() result onto a 2D canvas context (page canvas or OffscreenCanvas). */
  function drawSketch(ctx, sketch) {
    ctx.fillStyle = '#f3efe6';
    ctx.fillRect(0, 0, sketch.width, sketch.height);

    if (sketch.trail.length >= 2) {
      ctx.strokeStyle = 'rgba(27, 111, 214, 0.55)';
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sketch.trail[0].x, sketch.trail[0].y);
      for (var i = 1; i < sketch.trail.length; i++) ctx.lineTo(sketch.trail[i].x, sketch.trail[i].y);
      ctx.stroke();
    }

    // Straight dashed line from the car to the hazard -- "it's over there",
    // not a claim about the road between them.
    ctx.strokeStyle = '#8a8f98';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(sketch.car.x, sketch.car.y);
    ctx.lineTo(sketch.hazard.x, sketch.hazard.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#e0392b';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sketch.hazard.x, sketch.hazard.y, 9, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#1b6fd6';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (sketch.car.headingDeg === null) {
      ctx.arc(sketch.car.x, sketch.car.y, 7, 0, 2 * Math.PI);
    } else {
      // An arrowhead pointing up (north), rotated clockwise by the heading.
      ctx.save();
      ctx.translate(sketch.car.x, sketch.car.y);
      ctx.rotate(toRadians(sketch.car.headingDeg));
      ctx.moveTo(0, -12);
      ctx.lineTo(8, 9);
      ctx.lineTo(0, 4);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.restore();
    }
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 15px sans-serif';
    var textWidth = ctx.measureText(sketch.label).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(10, sketch.height - 34, textWidth + 16, 24);
    ctx.fillStyle = '#222222';
    ctx.textBaseline = 'middle';
    ctx.fillText(sketch.label, 18, sketch.height - 22);
  }

  /**
   * Renders the sketch to a PNG data: URL for Notification's `image`
   * option. Resolves null where it can't (no OffscreenCanvas, bad input) --
   * callers then just show a text-only notification.
   */
  function renderSketchDataUrl(input) {
    if (typeof OffscreenCanvas === 'undefined') return Promise.resolve(null);
    var sketch = buildSketch(input);
    if (!sketch) return Promise.resolve(null);
    var canvas = new OffscreenCanvas(sketch.width, sketch.height);
    var ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    drawSketch(ctx, sketch);
    return canvas
      .convertToBlob({ type: 'image/png' })
      .then(function (blob) {
        return blob.arrayBuffer();
      })
      .then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return 'data:image/png;base64,' + btoa(binary);
      });
  }

  root.RoadAlertSketch = {
    buildSketch: buildSketch,
    drawSketch: drawSketch,
    renderSketchDataUrl: renderSketchDataUrl,
    formatDistance: formatDistance,
  };
})(typeof self !== 'undefined' ? self : globalThis);
