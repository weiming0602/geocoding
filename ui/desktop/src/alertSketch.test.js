import { beforeAll, describe, expect, it } from 'vitest';

// public/alert-sketch.js is a plain script (the service worker loads it
// with importScripts), so it registers itself on the global object rather
// than exporting anything. Plain .js test file for the same reason --
// there's no TypeScript declaration for it.
let sketchApi;
beforeAll(async () => {
  await import('../public/alert-sketch.js');
  sketchApi = globalThis.RoadAlertSketch;
});

// Freeport, ME. 0.001 degrees of latitude is ~111 m.
const CAR = { latitude: 43.85, longitude: -70.1 };
const NORTH_800M = { latitude: 43.85 + 800 / 111195, longitude: -70.1 };

function inside(point, sketch) {
  return point.x >= 0 && point.x <= sketch.width && point.y >= 0 && point.y <= sketch.height;
}

describe('buildSketch', () => {
  it('puts a hazard to the north above the car (north up)', () => {
    const sketch = sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M, headingDeg: 0 });
    expect(sketch.hazard.y).toBeLessThan(sketch.car.y);
    expect(Math.abs(sketch.hazard.x - sketch.car.x)).toBeLessThan(1);
  });

  it('puts a hazard to the east right of the car', () => {
    const east = { latitude: 43.85, longitude: -70.09 };
    const sketch = sketchApi.buildSketch({ position: CAR, hazard: east, headingDeg: 90 });
    expect(sketch.hazard.x).toBeGreaterThan(sketch.car.x);
    expect(Math.abs(sketch.hazard.y - sketch.car.y)).toBeLessThan(1);
  });

  it('keeps the trail, car and hazard inside the picture and above the label band', () => {
    const trail = [
      { latitude: 43.84, longitude: -70.12 },
      { latitude: 43.845, longitude: -70.11 },
    ];
    const sketch = sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M, headingDeg: 30, trail });
    for (const point of [...sketch.trail, sketch.car, sketch.hazard]) {
      expect(inside(point, sketch)).toBe(true);
      expect(point.y).toBeLessThan(sketch.height - 28);
    }
    // The trail ends at the car.
    expect(sketch.trail.at(-1)).toEqual({ x: sketch.car.x, y: sketch.car.y });
    expect(sketch.trail).toHaveLength(3);
  });

  it('does not zoom in tighter than ~300 m for a very close hazard', () => {
    const close = { latitude: 43.85 + 40 / 111195, longitude: -70.1 };
    const sketch = sketchApi.buildSketch({ position: CAR, hazard: close, headingDeg: 0 });
    // 40 m of a >= 300 m span over ~102 px of drawable height: under ~14 px apart.
    expect(sketch.car.y - sketch.hazard.y).toBeLessThan(15);
    expect(sketch.car.y - sketch.hazard.y).toBeGreaterThan(5);
  });

  it('labels the straight-line distance', () => {
    expect(sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M }).label).toBe('800 m away');
    const far = { latitude: 43.85 + 1400 / 111195, longitude: -70.1 };
    expect(sketchApi.buildSketch({ position: CAR, hazard: far }).label).toBe('1.4 km away');
  });

  it('marks an unknown heading as null (drawn as a dot, not an arrow)', () => {
    expect(sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M, headingDeg: null }).car.headingDeg).toBeNull();
    expect(sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M, headingDeg: -1 }).car.headingDeg).toBeNull();
    expect(sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M, headingDeg: 450 }).car.headingDeg).toBe(90);
  });

  it('has no trail when none is given', () => {
    expect(sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M }).trail).toEqual([]);
  });

  it('returns null without a real position or hazard', () => {
    expect(sketchApi.buildSketch({ position: CAR })).toBeNull();
    expect(sketchApi.buildSketch({ position: { latitude: NaN, longitude: 1 }, hazard: NORTH_800M })).toBeNull();
    expect(sketchApi.buildSketch(null)).toBeNull();
  });
});

describe('drawSketch', () => {
  // jsdom has no real canvas -- a recording fake checks what gets drawn.
  function recordingContext() {
    const calls = [];
    return new Proxy(
      { calls, measureText: (text) => ({ width: text.length * 8 }) },
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          return (...args) => calls.push([prop, ...args]);
        },
        set(target, prop, value) {
          calls.push([`set ${String(prop)}`, value]);
          return true;
        },
      }
    );
  }

  it('draws the trail line, the hazard dot, an arrow for a known heading, and the label', () => {
    const ctx = recordingContext();
    const trail = [{ latitude: 43.845, longitude: -70.1 }];
    sketchApi.drawSketch(ctx, sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M, headingDeg: 0, trail }));
    const names = ctx.calls.map((call) => call[0]);
    expect(names).toContain('lineTo'); // trail + dashed line
    expect(ctx.calls.filter((call) => call[0] === 'arc')).toHaveLength(1); // hazard only; the car is an arrow
    expect(names).toContain('rotate');
    expect(ctx.calls).toContainEqual(['fillText', '800 m away', 18, 158]);
  });

  it('draws the car as a dot when the heading is unknown', () => {
    const ctx = recordingContext();
    sketchApi.drawSketch(ctx, sketchApi.buildSketch({ position: CAR, hazard: NORTH_800M, headingDeg: null }));
    expect(ctx.calls.filter((call) => call[0] === 'arc')).toHaveLength(2);
    expect(ctx.calls.map((call) => call[0])).not.toContain('rotate');
  });
});

describe('renderSketchDataUrl', () => {
  it('resolves null where OffscreenCanvas is unavailable (e.g. jsdom), so callers fall back to text-only', async () => {
    expect(await sketchApi.renderSketchDataUrl({ position: CAR, hazard: NORTH_800M })).toBeNull();
  });
});
