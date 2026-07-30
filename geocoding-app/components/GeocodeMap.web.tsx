import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { OSM_RASTER_STYLE } from './osmStyle';

type Props = {
  latitude: number;
  longitude: number;
};

export default function GeocodeMap({ latitude, longitude }: Props) {
  const containerRef = useRef<View>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);

  useEffect(() => {
    const container = containerRef.current as unknown as HTMLElement | null;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: OSM_RASTER_STYLE,
      center: [longitude, latitude],
      zoom: 15,
    });
    map.addControl(new NavigationControl(), 'top-right');

    mapRef.current = map;
    markerRef.current = new Marker().setLngLat([longitude, latitude]).addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Map is created once on mount; position updates are handled by the
    // effect below so we don't tear down and rebuild the map on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setCenter([longitude, latitude]);
    markerRef.current?.setLngLat([longitude, latitude]);
  }, [latitude, longitude]);

  return <View ref={containerRef} style={{ height: 240, borderRadius: 8, overflow: 'hidden' }} />;
}
