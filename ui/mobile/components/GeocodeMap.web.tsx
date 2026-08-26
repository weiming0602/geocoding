import { Map as MapLibreMap, Marker, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { attachHoverLabel } from './mapHoverLabel';
import { OSM_RASTER_STYLE } from './osmStyle';

type Props = {
  latitude: number;
  longitude: number;
  label?: string;
};

export default function GeocodeMap({ latitude, longitude, label }: Props) {
  const containerRef = useRef<View>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<Popup | null>(null);

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
    // See BatchGeocodeMap.web.tsx / public/README.md -- a style/tile-load
    // failure here previously had no visible symptom at all beyond a
    // missing map, worth logging instead of leaving silent.
    map.on('error', (e) => console.error('GeocodeMap: map error', e.error));

    const marker = new Marker().setLngLat([longitude, latitude]).addTo(map);
    mapRef.current = map;
    markerRef.current = marker;
    popupRef.current = attachHoverLabel(marker, map, label ?? '');

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      popupRef.current = null;
    };
    // Map is created once on mount; position/label updates are handled by
    // the effect below so we don't tear down and rebuild on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setCenter([longitude, latitude]);
    markerRef.current?.setLngLat([longitude, latitude]);
    popupRef.current?.setText(label ?? '');
  }, [latitude, longitude, label]);

  return <View ref={containerRef} style={{ height: 240, borderRadius: 8, overflow: 'hidden' }} />;
}
