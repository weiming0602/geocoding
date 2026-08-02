import { Map as MapLibreMap, Marker, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';

import { attachHoverLabel } from '../map/mapHoverLabel';
import { OSM_RASTER_STYLE } from '../map/osmStyle';

// Roughly the center of the continental US -- shown before any result
// exists yet (e.g. Reverse geocode before the first click).
const DEFAULT_CENTER: [number, number] = [-98.5, 39.8];

type Props = {
  latitude?: number;
  longitude?: number;
  label?: string;
  onMapClick?: (coordinates: { latitude: number; longitude: number }) => void;
};

export default function MapView({ latitude, longitude, label, onMapClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const hasPoint = latitude !== undefined && longitude !== undefined;
    const map = new MapLibreMap({
      container,
      style: OSM_RASTER_STYLE,
      center: hasPoint ? [longitude!, latitude!] : DEFAULT_CENTER,
      zoom: hasPoint ? 15 : 3,
    });
    map.addControl(new NavigationControl(), 'top-right');
    map.on('click', (e) => {
      onMapClickRef.current?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
    });
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      popupRef.current = null;
    };
    // Map is created once on mount; position/marker updates are handled
    // by the effect below so we don't tear down and rebuild on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (latitude === undefined || longitude === undefined) {
      markerRef.current?.remove();
      markerRef.current = null;
      popupRef.current = null;
      return;
    }

    map.setCenter([longitude, latitude]);
    if (map.getZoom() < 14) map.setZoom(15);

    if (!markerRef.current) {
      markerRef.current = new Marker().setLngLat([longitude, latitude]).addTo(map);
      popupRef.current = attachHoverLabel(markerRef.current, map, label ?? '');
    } else {
      markerRef.current.setLngLat([longitude, latitude]);
      popupRef.current?.setText(label ?? '');
    }
  }, [latitude, longitude, label]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height: 420,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-divider)',
        background: 'var(--color-surface)',
        overflow: 'hidden',
        cursor: onMapClick ? 'crosshair' : 'default',
      }}
    />
  );
}
