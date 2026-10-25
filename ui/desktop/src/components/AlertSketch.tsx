import { useEffect, useRef } from 'react';

import type { AlertSketchInput } from '../roadAlertNotifications';

// public/alert-sketch.js, loaded by index.html as a plain script (the
// service worker loads the same file for notification images), puts its
// API on window -- see that file for what the sketch shows.
type SketchLayout = { width: number; height: number };
declare global {
  interface Window {
    RoadAlertSketch?: {
      buildSketch: (input: AlertSketchInput) => SketchLayout | null;
      drawSketch: (ctx: CanvasRenderingContext2D, sketch: SketchLayout) => void;
    };
  }
}

/**
 * The same trail/heading/hazard picture Road Alerts notifications carry,
 * drawn inline on a hazard's card -- so it shows in every browser, not
 * just the platforms whose notification centers display images. Redraws
 * whenever the input changes (the car moves, the trail grows). Renders
 * nothing if the sketch script didn't load or the input isn't drawable.
 */
export default function AlertSketch({ input }: { input: AlertSketchInput }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sketch = window.RoadAlertSketch?.buildSketch(input) ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const api = window.RoadAlertSketch;
    if (!canvas || !api || !sketch) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Draw at the screen's pixel density so the line and text stay crisp.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = sketch.width * ratio;
    canvas.height = sketch.height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    api.drawSketch(ctx, sketch);
  }, [sketch]);

  if (!sketch) return null;
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Sketch of your recent route, your heading, and where this hazard is"
      style={{
        display: 'block',
        width: '100%',
        maxWidth: sketch.width,
        aspectRatio: `${sketch.width} / ${sketch.height}`,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-divider)',
        margin: 'var(--space-2) 0',
      }}
    />
  );
}
