import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

import { attachHoverLabel } from '../map/mapHoverLabel';
import { OSM_RASTER_STYLE } from '../map/osmStyle';

export type MarkerPoint = {
  address: string;
  latitude: number;
  longitude: number;
};

const SIZES = { Compact: 220, Default: 320, Large: 560 } as const;
type SizeName = keyof typeof SIZES;

export default function BatchMapView({ markers }: { markers: MarkerPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerInstancesRef = useRef<Marker[]>([]);
  const [size, setSize] = useState<SizeName>('Default');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({ container, style: OSM_RASTER_STYLE, center: [0, 0], zoom: 1 });
    map.addControl(new NavigationControl(), 'top-right');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerInstancesRef.current = [];
    };
    // Map is created once on mount; markers are (re)placed by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markerInstancesRef.current.forEach((marker) => marker.remove());
    markerInstancesRef.current = markers.map((point) => {
      const marker = new Marker().setLngLat([point.longitude, point.latitude]).addTo(map);
      attachHoverLabel(marker, map, point.address);
      return marker;
    });

    if (markers.length === 0) return;

    if (markers.length === 1) {
      map.setCenter([markers[0].longitude, markers[0].latitude]);
      map.setZoom(15);
      return;
    }

    const bounds = markers.reduce(
      (acc, point) => acc.extend([point.longitude, point.latitude]),
      new LngLatBounds(
        [markers[0].longitude, markers[0].latitude],
        [markers[0].longitude, markers[0].latitude]
      )
    );
    map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
  }, [markers]);

  // MapLibre renders to a fixed-size canvas -- it doesn't notice its
  // container growing/shrinking on its own, so resize() has to be
  // called explicitly whenever the height changes (after the browser
  // has actually applied the new height, hence requestAnimationFrame
  // rather than calling it synchronously in the same tick).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const frame = requestAnimationFrame(() => map.resize());
    return () => cancelAnimationFrame(frame);
  }, [size]);

  if (markers.length === 0) return null;

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          height: SIZES[size],
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-divider)',
          overflow: 'hidden',
        }}
      />
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        {(Object.keys(SIZES) as SizeName[]).map((name) => (
          <button
            key={name}
            className={size === name ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setSize(name)}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
