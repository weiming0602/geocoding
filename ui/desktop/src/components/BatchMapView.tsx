import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';

import { attachHoverLabel } from '../map/mapHoverLabel';
import { OSM_RASTER_STYLE } from '../map/osmStyle';

export type MarkerPoint = {
  address: string;
  latitude: number;
  longitude: number;
};

export default function BatchMapView({ markers }: { markers: MarkerPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerInstancesRef = useRef<Marker[]>([]);

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

  if (markers.length === 0) return null;

  return (
    <div
      ref={containerRef}
      style={{
        height: 320,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-divider)',
        overflow: 'hidden',
      }}
    />
  );
}
