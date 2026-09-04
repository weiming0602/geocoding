import { Map as MapLibreMap, LngLatBounds, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

import { attachHoverLabel } from '../map/mapHoverLabel';
import { OSM_RASTER_STYLE } from '../map/osmStyle';

// Roughly the center of the continental US -- shown before any point
// exists yet, same default as MapView.tsx.
const DEFAULT_CENTER: [number, number] = [-98.5, 39.8];

export type SandboxPoint = {
  latitude: number;
  longitude: number;
  // Plain text, not JSX -- rendered via a maplibre-gl Popup (see
  // mapHoverLabel.ts), which only ever takes text.
  label: string;
  color: string;
};

type Props = {
  points: SandboxPoint[];
  driverPosition?: { latitude: number; longitude: number } | null;
  onMapClick?: (coordinates: { latitude: number; longitude: number }) => void;
};

// Plain DOM Markers (one per point), not BatchMapView's WebGL circle
// layer -- a sandbox never has more than a handful of points at once
// (you're placing them by hand), so the per-point DOM cost that layer
// exists to avoid never actually applies here, and per-point color/hover
// label is far simpler to express this way.
export default function RoadAlertsSandboxMap({ points, driverPosition, onMapClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const markersRef = useRef<Marker[]>([]);
  const driverMarkerRef = useRef<Marker | null>(null);
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const hasFitOnceRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({ container, style: OSM_RASTER_STYLE, center: DEFAULT_CENTER, zoom: 3 });
    map.addControl(new NavigationControl(), 'top-right');
    map.on('click', (e) => {
      onMapClickRef.current?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
    });
    map.on('load', () => setReady(true));
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = [];
      driverMarkerRef.current = null;
    };
    // Map is created once on mount; point/driver rendering is handled by
    // the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    for (const marker of markersRef.current) marker.remove();
    markersRef.current = points.map((point) => {
      const el = document.createElement('div');
      el.style.width = '16px';
      el.style.height = '16px';
      el.style.borderRadius = '50%';
      el.style.background = point.color;
      el.style.border = '2px solid #ffffff';
      el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
      const marker = new Marker({ element: el }).setLngLat([point.longitude, point.latitude]).addTo(map);
      attachHoverLabel(marker, map, point.label);
      return marker;
    });

    // Fit to all points once, the first time any exist -- afterward the
    // user's own pan/zoom is left alone rather than re-fit on every
    // single point added, which would be disorienting mid-session.
    if (!hasFitOnceRef.current && points.length > 0) {
      hasFitOnceRef.current = true;
      if (points.length === 1) {
        map.setCenter([points[0].longitude, points[0].latitude]);
        map.setZoom(12);
      } else {
        const bounds = points.reduce(
          (acc, p) => acc.extend([p.longitude, p.latitude]),
          new LngLatBounds([points[0].longitude, points[0].latitude], [points[0].longitude, points[0].latitude])
        );
        map.fitBounds(bounds, { padding: 60, maxZoom: 14 });
      }
    }
  }, [points, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (!driverPosition) {
      driverMarkerRef.current?.remove();
      driverMarkerRef.current = null;
      return;
    }

    if (!driverMarkerRef.current) {
      const el = document.createElement('div');
      el.style.width = '20px';
      el.style.height = '20px';
      el.style.borderRadius = '50%';
      el.style.background = '#1b6fd6';
      el.style.border = '3px solid #ffffff';
      el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.5)';
      driverMarkerRef.current = new Marker({ element: el })
        .setLngLat([driverPosition.longitude, driverPosition.latitude])
        .addTo(map);
      attachHoverLabel(driverMarkerRef.current, map, 'Simulated driver position');
    } else {
      driverMarkerRef.current.setLngLat([driverPosition.longitude, driverPosition.latitude]);
    }
  }, [driverPosition, ready]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height: 480,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-divider)',
        background: 'var(--color-surface)',
        overflow: 'hidden',
        cursor: onMapClick ? 'crosshair' : 'default',
      }}
    />
  );
}
