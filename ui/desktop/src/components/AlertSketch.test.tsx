import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import AlertSketch from './AlertSketch';

const input = {
  trail: [{ latitude: 43.845, longitude: -70.1 }],
  position: { latitude: 43.85, longitude: -70.1 },
  headingDeg: 0,
  hazard: { latitude: 43.85 + 800 / 111195, longitude: -70.1 },
};

describe('AlertSketch', () => {
  let loadedApi: Window['RoadAlertSketch'];
  beforeAll(async () => {
    // The real drawing script, as index.html loads it.
    // @ts-expect-error -- plain JS file with no type declaration
    await import('../../public/alert-sketch.js');
    loadedApi = window.RoadAlertSketch;
  });
  afterEach(() => {
    window.RoadAlertSketch = loadedApi;
    vi.restoreAllMocks();
  });

  it('draws the sketch onto a canvas, label included', () => {
    // jsdom has no real canvas; record what gets drawn instead.
    const calls: unknown[][] = [];
    const ctx = new Proxy(
      { measureText: (text: string) => ({ width: text.length * 8 }) } as Record<string, unknown>,
      {
        get: (target, prop) => (prop in target ? target[prop as string] : (...args: unknown[]) => calls.push([prop, ...args])),
        set: () => true,
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    render(<AlertSketch input={input} />);
    expect(screen.getByRole('img', { name: /sketch of your recent route/i })).toBeInTheDocument();
    expect(calls).toContainEqual(['fillText', '800 m away', 18, 158]);
  });

  it('renders nothing when the sketch script is not loaded', () => {
    window.RoadAlertSketch = undefined;
    const { container } = render(<AlertSketch input={input} />);
    expect(container).toBeEmptyDOMElement();
  });
});
